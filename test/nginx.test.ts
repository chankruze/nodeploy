import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const { buildServerBlock, buildStaticServerBlock, deployProxyConfig, deployStaticProxyConfig } = await import(
  "../src/lib/nginx.js"
);

describe("buildServerBlock", () => {
  it("generates an nginx server block proxying to the given port", () => {
    const block = buildServerBlock("api.local", 3000);

    expect(block).toContain("server_name api.local;");
    expect(block).toContain("proxy_pass http://127.0.0.1:3000;");
  });

  it("serves the ACME challenge webroot on plain HTTP so a first cert can be issued", () => {
    const block = buildServerBlock("api.example.com", 3000);

    expect(block).toContain("location /.well-known/acme-challenge/");
    expect(block).toContain("root /var/www/certbot;");
    expect(block).not.toContain("listen 443");
  });

  it("with ssl, redirects port 80 to https and proxies from a 443 block using the host's cert", () => {
    const block = buildServerBlock("api.example.com", 3000, true);
    const [httpBlock, httpsBlock] = block.split(/\n(?=server \{)/);

    expect(httpBlock).toContain("listen 80;");
    expect(httpBlock).toContain("location /.well-known/acme-challenge/");
    expect(httpBlock).toContain("return 301 https://$host$request_uri;");
    expect(httpBlock).not.toContain("proxy_pass");

    expect(httpsBlock).toContain("listen 443 ssl http2;");
    expect(httpsBlock).toContain("server_name api.example.com;");
    expect(httpsBlock).toContain(
      "ssl_certificate /etc/letsencrypt/live/api.example.com/fullchain.pem;",
    );
    expect(httpsBlock).toContain(
      "ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;",
    );
    expect(httpsBlock).toContain("proxy_pass http://127.0.0.1:3000;");
  });
});

describe("buildStaticServerBlock", () => {
  it("generates an nginx server block serving static files from the given root", () => {
    const block = buildStaticServerBlock("app.local", "~/apps/app/dist");

    expect(block).toContain("server_name app.local;");
    expect(block).toContain("root ~/apps/app/dist;");
    expect(block).toContain("try_files $uri $uri/ /index.html;");
  });

  it("with ssl, serves the static root from the 443 block only", () => {
    const block = buildStaticServerBlock("app.example.com", "/root/apps/app/dist", true);
    const [httpBlock, httpsBlock] = block.split(/\n(?=server \{)/);

    expect(httpBlock).not.toContain("root /root/apps/app/dist;");
    expect(httpsBlock).toContain("listen 443 ssl http2;");
    expect(httpsBlock).toContain("root /root/apps/app/dist;");
  });
});

describe("deployProxyConfig", () => {
  const target: SSHTarget = { host: "1.2.3.4", user: "root", port: 22 };

  beforeEach(() => {
    execa.mockReset();
  });

  it("writes, enables, tests, and reloads nginx over ssh with the block as stdin", async () => {
    execa.mockResolvedValueOnce({});

    await deployProxyConfig(target, "api", "api.local", 3000);

    expect(execa).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = execa.mock.calls[0];
    expect(bin).toBe("ssh");
    expect(args[0]).toBe("-p");
    expect(args[2]).toBe("root@1.2.3.4");

    const remoteCommand = args[args.length - 1] as string;
    expect(remoteCommand).toContain(
      'sudo tee "/etc/nginx/sites-available/api.conf"',
    );
    expect(remoteCommand).toContain(
      'sudo ln -sf "/etc/nginx/sites-available/api.conf" "/etc/nginx/sites-enabled/api.conf"',
    );
    expect(remoteCommand).toContain("sudo nginx -t");
    expect(remoteCommand).toContain("sudo systemctl reload nginx");

    expect(opts.input).toContain("server_name api.local;");
  });

  it("with ssl and an existing cert, writes the HTTPS config directly", async () => {
    execa.mockResolvedValueOnce({}); // cert exists
    execa.mockResolvedValueOnce({}); // write + reload

    await deployProxyConfig(target, "api", "api.example.com", 3000, {});

    expect(execa).toHaveBeenCalledTimes(2);
    expect(lastArg(0)).toBe(
      'sudo test -f "/etc/letsencrypt/live/api.example.com/fullchain.pem"',
    );
    expect(execa.mock.calls[1][2].input).toContain("listen 443 ssl http2;");
  });

  it("with ssl and no cert yet, serves HTTP first, runs certbot, then switches to HTTPS", async () => {
    execa.mockRejectedValueOnce(new Error("exit 1")); // no cert
    execa.mockResolvedValueOnce({}); // HTTP-only write + reload
    execa.mockResolvedValueOnce({}); // certbot
    execa.mockResolvedValueOnce({}); // HTTPS write + reload

    await deployProxyConfig(target, "api", "api.example.com", 3000, {
      email: "me@example.com",
    });

    expect(execa).toHaveBeenCalledTimes(4);

    const bootstrap = execa.mock.calls[1][2].input as string;
    expect(bootstrap).toContain("location /.well-known/acme-challenge/");
    expect(bootstrap).not.toContain("listen 443");

    const certbot = lastArg(2);
    expect(certbot).toContain('sudo mkdir -p "/var/www/certbot"');
    expect(certbot).toContain("sudo certbot certonly --webroot");
    expect(certbot).toContain('-w "/var/www/certbot"');
    expect(certbot).toContain('-d "api.example.com"');
    expect(certbot).toContain('--cert-name "api.example.com"');
    expect(certbot).toContain('--email "me@example.com"');
    expect(certbot).toContain("--agree-tos --non-interactive");
    expect(certbot).toContain('--deploy-hook "systemctl reload nginx"');

    expect(execa.mock.calls[3][2].input).toContain("listen 443 ssl http2;");
  });

  it("registers without an email when none is configured", async () => {
    execa.mockRejectedValueOnce(new Error("exit 1"));
    execa.mockResolvedValue({});

    await deployProxyConfig(target, "api", "api.example.com", 3000, {});

    expect(lastArg(2)).toContain("--register-unsafely-without-email");
  });

  it("explains DNS/port 80 requirements and never writes the HTTPS config when certbot fails", async () => {
    execa.mockRejectedValueOnce(new Error("exit 1")); // no cert
    execa.mockResolvedValueOnce({}); // HTTP-only write
    execa.mockRejectedValueOnce(new Error("challenge failed")); // certbot

    await expect(
      deployProxyConfig(target, "api", "api.example.com", 3000, {}),
    ).rejects.toThrow(/DNS record points at this server and port 80/);
    expect(execa).toHaveBeenCalledTimes(3);
  });
});

function lastArg(call: number): string {
  const args = execa.mock.calls[call][1] as string[];
  return args[args.length - 1];
}

describe("deployStaticProxyConfig", () => {
  const target: SSHTarget = { host: "1.2.3.4", user: "root", port: 22 };

  beforeEach(() => {
    execa.mockReset();
  });

  it("writes, enables, tests, and reloads nginx with a static server block as stdin", async () => {
    execa.mockResolvedValueOnce({}).mockResolvedValueOnce({});

    await deployStaticProxyConfig(
      target,
      "app",
      "app.local",
      "~/apps/app/dist",
    );

    expect(execa).toHaveBeenCalledTimes(2);
    const [, args, opts] = execa.mock.calls[1];

    const remoteCommand = args[args.length - 1] as string;
    expect(remoteCommand).toContain(
      'sudo tee "/etc/nginx/sites-available/app.conf"',
    );
    expect(remoteCommand).toContain("sudo nginx -t");
    expect(remoteCommand).toContain("sudo systemctl reload nginx");

    expect(opts.input).toContain("root ~/apps/app/dist;");
  });

  it("makes $HOME traversable so nginx (running as www-data) can reach the static build", async () => {
    execa.mockResolvedValueOnce({}).mockResolvedValueOnce({});

    await deployStaticProxyConfig(
      target,
      "app",
      "app.local",
      "~/apps/app/dist",
    );

    const [, args] = execa.mock.calls[0];
    const remoteCommand = args[args.length - 1] as string;
    expect(remoteCommand).toBe("chmod o+x $HOME");
  });

  it("with ssl, serves the static build over HTTPS", async () => {
    execa.mockResolvedValue({}); // chmod, cert exists, write

    await deployStaticProxyConfig(
      target,
      "app",
      "app.example.com",
      "/root/apps/app/dist",
      {},
    );

    expect(execa).toHaveBeenCalledTimes(3);
    const input = execa.mock.calls[2][2].input as string;
    expect(input).toContain("listen 443 ssl http2;");
    expect(input).toContain("root /root/apps/app/dist;");
  });
});
