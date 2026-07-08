import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const { buildServerBlock, buildStaticServerBlock, deployProxyConfig, deployStaticProxyConfig } = await import(
  "../src/lib/nginx.js"
);

describe("buildServerBlock", () => {
  it("generates an nginx server block proxying to the given port", () => {
    const block = buildServerBlock("api", "api.local", 3000);

    expect(block).toContain("server_name api.local;");
    expect(block).toContain("proxy_pass http://127.0.0.1:3000;");
  });
});

describe("buildStaticServerBlock", () => {
  it("generates an nginx server block serving static files from the given root", () => {
    const block = buildStaticServerBlock("app.local", "~/apps/app/dist");

    expect(block).toContain("server_name app.local;");
    expect(block).toContain("root ~/apps/app/dist;");
    expect(block).toContain("try_files $uri $uri/ /index.html;");
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
});

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
});
