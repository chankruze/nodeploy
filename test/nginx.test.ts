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

// deploySite's first remote call checks whether the target is an edge
// (i.e. has the SNI router config); `test -f` failing means it isn't.
function notAnEdge(): void {
  execa.mockRejectedValueOnce(new Error("exit 1"));
}

function lastArg(call: number): string {
  const args = execa.mock.calls[call][1] as string[];
  return args[args.length - 1];
}

function input(call: number): string {
  return execa.mock.calls[call][2].input as string;
}

describe("deployProxyConfig", () => {
  const target: SSHTarget = { host: "1.2.3.4", user: "root", port: 22 };

  beforeEach(() => {
    execa.mockReset();
  });

  it("writes, enables, tests, and reloads nginx over ssh with the block as stdin", async () => {
    notAnEdge();
    execa.mockResolvedValueOnce({});

    await deployProxyConfig(target, "api", "api.local", 3000);

    expect(execa).toHaveBeenCalledTimes(2);
    expect(lastArg(0)).toBe('test -f "/etc/nginx/stream.d/nodeploy.conf"');

    const [bin, args] = execa.mock.calls[1];
    expect(bin).toBe("ssh");
    expect(args[0]).toBe("-p");
    expect(args[2]).toBe("root@1.2.3.4");

    const remoteCommand = lastArg(1);
    expect(remoteCommand).toContain(
      'sudo tee "/etc/nginx/sites-available/api.conf"',
    );
    expect(remoteCommand).toContain(
      'sudo ln -sf "/etc/nginx/sites-available/api.conf" "/etc/nginx/sites-enabled/api.conf"',
    );
    expect(remoteCommand).toContain("sudo nginx -t");
    expect(remoteCommand).toContain("sudo systemctl reload nginx");

    expect(input(1)).toContain("server_name api.local;");
  });

  it("with ssl and an existing cert, writes the HTTPS config directly", async () => {
    notAnEdge();
    execa.mockResolvedValueOnce({}); // cert exists
    execa.mockResolvedValueOnce({}); // write + reload

    await deployProxyConfig(target, "api", "api.example.com", 3000, {});

    expect(execa).toHaveBeenCalledTimes(3);
    expect(lastArg(1)).toBe(
      'sudo test -f "/etc/letsencrypt/live/api.example.com/fullchain.pem"',
    );
    expect(input(2)).toContain("listen 443 ssl http2;");
  });

  it("with ssl and no cert yet, serves HTTP first, runs certbot, then switches to HTTPS", async () => {
    notAnEdge();
    execa.mockRejectedValueOnce(new Error("exit 1")); // no cert
    execa.mockResolvedValueOnce({}); // HTTP-only write + reload
    execa.mockResolvedValueOnce({}); // certbot
    execa.mockResolvedValueOnce({}); // HTTPS write + reload

    await deployProxyConfig(target, "api", "api.example.com", 3000, {
      email: "me@example.com",
    });

    expect(execa).toHaveBeenCalledTimes(5);

    const bootstrap = input(2);
    expect(bootstrap).toContain("location /.well-known/acme-challenge/");
    expect(bootstrap).not.toContain("listen 443");

    const certbot = lastArg(3);
    expect(certbot).toContain('sudo mkdir -p "/var/www/certbot"');
    expect(certbot).toContain("sudo certbot certonly --webroot");
    expect(certbot).toContain('-w "/var/www/certbot"');
    expect(certbot).toContain('-d "api.example.com"');
    expect(certbot).toContain('--cert-name "api.example.com"');
    expect(certbot).toContain('--email "me@example.com"');
    expect(certbot).toContain("--agree-tos --non-interactive");
    expect(certbot).toContain('--deploy-hook "systemctl reload nginx"');

    expect(input(4)).toContain("listen 443 ssl http2;");
  });

  it("registers without an email when none is configured", async () => {
    notAnEdge();
    execa.mockRejectedValueOnce(new Error("exit 1")); // no cert
    execa.mockResolvedValue({});

    await deployProxyConfig(target, "api", "api.example.com", 3000, {});

    expect(lastArg(3)).toContain("--register-unsafely-without-email");
  });

  it("explains DNS/port 80 requirements and never writes the HTTPS config when certbot fails", async () => {
    notAnEdge();
    execa.mockRejectedValueOnce(new Error("exit 1")); // no cert
    execa.mockResolvedValueOnce({}); // HTTP-only write
    execa.mockRejectedValueOnce(new Error("challenge failed")); // certbot

    await expect(
      deployProxyConfig(target, "api", "api.example.com", 3000, {}),
    ).rejects.toThrow(/DNS record points at this server and port 80/);
    expect(execa).toHaveBeenCalledTimes(4);
  });

  describe("on an edge box (its SNI router owns 443)", () => {
    it("with ssl, listens on the local TLS port and routes the host there, in one transactional apply", async () => {
      execa.mockResolvedValueOnce({}); // is an edge
      execa.mockResolvedValueOnce({}); // cert exists
      execa.mockResolvedValueOnce({}); // apply

      await deployProxyConfig(target, "payroll", "payroll.example.com", 8080, {});

      expect(execa).toHaveBeenCalledTimes(3);
      expect(lastArg(2)).toBe("bash -s");

      const script = input(2);
      expect(script).toContain('sudo tee "/etc/nginx/sites-available/payroll.conf"');
      expect(script).toContain(
        'sudo ln -sf "/etc/nginx/sites-available/payroll.conf" "/etc/nginx/sites-enabled/payroll.conf"',
      );
      expect(script).toContain("listen 127.0.0.1:8443 ssl http2;");
      expect(script).not.toContain("listen 443 ssl http2;");
      expect(script).toContain(
        'sudo tee "/etc/nginx/stream.d/nodeploy-routes/payroll.example.com.conf"',
      );
      expect(script).toContain("payroll.example.com 127.0.0.1:8443;");
      expect(script).toContain("if ! sudo nginx -t; then");
    });

    it("issues a first cert over plain HTTP before switching to the local TLS port", async () => {
      execa.mockResolvedValueOnce({}); // is an edge
      execa.mockRejectedValueOnce(new Error("exit 1")); // no cert
      execa.mockResolvedValue({}); // HTTP-only write, certbot, apply

      await deployProxyConfig(target, "payroll", "payroll.example.com", 8080, {});

      expect(execa).toHaveBeenCalledTimes(5);
      expect(input(2)).not.toContain("8443");
      expect(lastArg(3)).toContain("sudo certbot certonly --webroot");
      expect(input(4)).toContain("listen 127.0.0.1:8443 ssl http2;");
    });

    it("without ssl, serves plain HTTP and removes any route left from when ssl was on", async () => {
      execa.mockResolvedValueOnce({}); // is an edge
      execa.mockResolvedValueOnce({}); // apply

      await deployProxyConfig(target, "payroll", "payroll.example.com", 8080);

      expect(execa).toHaveBeenCalledTimes(2);
      const script = input(1);
      expect(script).toContain("listen 80;");
      expect(script).not.toContain("8443");
      expect(script).toContain(
        'sudo rm -f "/etc/nginx/stream.d/nodeploy-routes/payroll.example.com.conf"',
      );
    });
  });
});

describe("deployStaticProxyConfig", () => {
  const target: SSHTarget = { host: "1.2.3.4", user: "root", port: 22 };

  beforeEach(() => {
    execa.mockReset();
  });

  it("writes, enables, tests, and reloads nginx with a static server block as stdin", async () => {
    execa.mockResolvedValueOnce({}); // chmod
    notAnEdge();
    execa.mockResolvedValueOnce({}); // write

    await deployStaticProxyConfig(
      target,
      "app",
      "app.local",
      "~/apps/app/dist",
    );

    expect(execa).toHaveBeenCalledTimes(3);
    const remoteCommand = lastArg(2);
    expect(remoteCommand).toContain(
      'sudo tee "/etc/nginx/sites-available/app.conf"',
    );
    expect(remoteCommand).toContain("sudo nginx -t");
    expect(remoteCommand).toContain("sudo systemctl reload nginx");

    expect(input(2)).toContain("root ~/apps/app/dist;");
  });

  it("makes $HOME traversable so nginx (running as www-data) can reach the static build", async () => {
    execa.mockResolvedValueOnce({}); // chmod
    notAnEdge();
    execa.mockResolvedValueOnce({}); // write

    await deployStaticProxyConfig(
      target,
      "app",
      "app.local",
      "~/apps/app/dist",
    );

    expect(lastArg(0)).toBe("chmod o+x $HOME");
  });

  it("with ssl, serves the static build over HTTPS", async () => {
    execa.mockResolvedValueOnce({}); // chmod
    notAnEdge();
    execa.mockResolvedValue({}); // cert exists, write

    await deployStaticProxyConfig(
      target,
      "app",
      "app.example.com",
      "/root/apps/app/dist",
      {},
    );

    expect(execa).toHaveBeenCalledTimes(4);
    expect(input(3)).toContain("listen 443 ssl http2;");
    expect(input(3)).toContain("root /root/apps/app/dist;");
  });

  it("on an edge with ssl, serves the static build on the local TLS port", async () => {
    execa.mockResolvedValue({}); // chmod, is an edge, cert exists, apply

    await deployStaticProxyConfig(
      target,
      "app",
      "app.example.com",
      "/root/apps/app/dist",
      {},
    );

    expect(execa).toHaveBeenCalledTimes(4);
    expect(input(3)).toContain("listen 127.0.0.1:8443 ssl http2;");
    expect(input(3)).toContain("app.example.com 127.0.0.1:8443;");
  });
});
