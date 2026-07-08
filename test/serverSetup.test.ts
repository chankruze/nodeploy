import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const { ensureDeployPath, ensureGit, ensureNginx, ensureNode, ensurePM2 } =
  await import("../src/lib/serverSetup.js");

const target: SSHTarget = {
  host: "203.0.113.10",
  user: "root",
  port: 22,
};

describe("serverSetup", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  it("ensureGit skips install when git is already present", async () => {
    execa.mockResolvedValueOnce({});
    const installed = await ensureGit(target);
    expect(installed).toBe(false);
    expect(execa).toHaveBeenCalledTimes(1);
  });

  it("ensureGit installs git via apt when missing", async () => {
    execa.mockRejectedValueOnce(new Error("not found"));
    execa.mockResolvedValueOnce({});
    const installed = await ensureGit(target);
    expect(installed).toBe(true);
    expect(execa).toHaveBeenNthCalledWith(
      2,
      "ssh",
      [
        "-p",
        "22",
        "root@203.0.113.10",
        "sudo apt-get update && sudo apt-get install -y git",
      ],
      { stdio: "inherit" },
    );
  });

  it("ensureNode installs via the configured NodeSource release line when missing", async () => {
    execa.mockRejectedValueOnce(new Error("not found"));
    execa.mockResolvedValueOnce({});
    const installed = await ensureNode(target, "22");
    expect(installed).toBe(true);
    const [, args, opts] = execa.mock.calls[1];
    expect(args[args.length - 1]).toContain("setup_22.x");
    expect(opts).toEqual({ stdio: "inherit" });
  });

  it("ensureNode skips install when node is already present", async () => {
    execa.mockResolvedValueOnce({});
    const installed = await ensureNode(target, "22");
    expect(installed).toBe(false);
    expect(execa).toHaveBeenCalledTimes(1);
  });

  it("ensurePM2 installs pm2 when missing and always runs pm2 startup", async () => {
    execa.mockRejectedValueOnce(new Error("not found")); // command -v pm2
    execa.mockResolvedValueOnce({}); // npm install -g pm2
    execa.mockResolvedValueOnce({}); // pm2 startup
    const installed = await ensurePM2(target);
    expect(installed).toBe(true);
    expect(execa).toHaveBeenCalledTimes(3);
    const [, args] = execa.mock.calls[2];
    expect(args[args.length - 1]).toContain("pm2 startup systemd");
  });

  it("ensurePM2 still runs pm2 startup when pm2 is already present", async () => {
    execa.mockResolvedValueOnce({}); // command -v pm2
    execa.mockResolvedValueOnce({}); // pm2 startup
    const installed = await ensurePM2(target);
    expect(installed).toBe(false);
    expect(execa).toHaveBeenCalledTimes(2);
  });

  it("ensureNginx installs and enables nginx when missing", async () => {
    execa.mockRejectedValueOnce(new Error("not found"));
    execa.mockResolvedValueOnce({});
    const installed = await ensureNginx(target);
    expect(installed).toBe(true);
    const [, args] = execa.mock.calls[1];
    expect(args[args.length - 1]).toContain("apt-get install -y nginx");
    expect(args[args.length - 1]).toContain("systemctl enable --now nginx");
  });

  it("ensureDeployPath makes the directory on the remote", async () => {
    execa.mockResolvedValueOnce({});
    await ensureDeployPath(target, "~/apps/api");
    expect(execa).toHaveBeenCalledWith(
      "ssh",
      ["-p", "22", "root@203.0.113.10", 'mkdir -p "~/apps/api"'],
      {},
    );
  });
});
