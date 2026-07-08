import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const { buildServerBlock, deployProxyConfig } = await import(
  "../src/lib/nginx.js"
);

describe("buildServerBlock", () => {
  it("generates an nginx server block proxying to the given port", () => {
    const block = buildServerBlock("api", "api.local", 3000);

    expect(block).toContain("server_name api.local;");
    expect(block).toContain("proxy_pass http://127.0.0.1:3000;");
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
