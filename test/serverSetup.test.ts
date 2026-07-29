import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const {
  ensureDeployPath,
  ensureGit,
  ensureNginx,
  ensureNode,
  ensurePM2,
  ensurePM2Startup,
  ensurePython,
} = await import("../src/lib/serverSetup.js");

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

  it("ensureNode installs nvm and the requested version when node is missing", async () => {
    execa.mockRejectedValueOnce(new Error("not found")); // command -v node
    execa.mockRejectedValueOnce(new Error("not found")); // command -v nvm
    execa.mockResolvedValueOnce({}); // nvm install script
    execa.mockResolvedValueOnce({}); // nvm install <version>
    const installed = await ensureNode(target, "22");
    expect(installed).toBe(true);

    const [, installScriptArgs, installScriptOpts] = execa.mock.calls[2];
    expect(installScriptArgs[installScriptArgs.length - 1]).toContain(
      "nvm-sh/nvm",
    );
    expect(installScriptOpts).toEqual({ stdio: "inherit" });

    const [, nvmInstallArgs] = execa.mock.calls[3];
    const command = nvmInstallArgs[nvmInstallArgs.length - 1] as string;
    expect(command).toContain("nvm install 22");
    expect(command).toContain("nvm alias default 22");
  });

  it("ensureNode skips the nvm install script when nvm is already present", async () => {
    execa.mockRejectedValueOnce(new Error("not found")); // command -v node
    execa.mockResolvedValueOnce({}); // command -v nvm
    execa.mockResolvedValueOnce({}); // nvm install <version>
    const installed = await ensureNode(target, "22");
    expect(installed).toBe(true);
    expect(execa).toHaveBeenCalledTimes(3);
  });

  it("ensureNode skips entirely when node is already present", async () => {
    execa.mockResolvedValueOnce({});
    const installed = await ensureNode(target, "22");
    expect(installed).toBe(false);
    expect(execa).toHaveBeenCalledTimes(1);
  });

  it("ensurePM2 installs pm2 via npm (no sudo) when missing", async () => {
    execa.mockRejectedValueOnce(new Error("not found")); // command -v pm2
    execa.mockResolvedValueOnce({}); // npm install -g pm2
    const installed = await ensurePM2(target);
    expect(installed).toBe(true);
    const [, args] = execa.mock.calls[1];
    expect(args[args.length - 1]).toContain("npm install -g pm2");
  });

  it("ensurePM2 skips install when pm2 is already present", async () => {
    execa.mockResolvedValueOnce({});
    const installed = await ensurePM2(target);
    expect(installed).toBe(false);
    expect(execa).toHaveBeenCalledTimes(1);
  });

  it("ensurePM2Startup runs pm2 startup systemd", async () => {
    execa.mockResolvedValueOnce({});
    await ensurePM2Startup(target);
    const [, args] = execa.mock.calls[0];
    expect(args[args.length - 1]).toContain("pm2 startup systemd");
  });

  it("ensurePM2Startup propagates failure when sudo is unavailable", async () => {
    execa.mockRejectedValueOnce(new Error("sudo: a password is required"));
    await expect(ensurePM2Startup(target)).rejects.toThrow();
  });

  it("ensurePython skips install when python3 venv module is already importable", async () => {
    execa.mockResolvedValueOnce({});
    const installed = await ensurePython(target);
    expect(installed).toBe(false);
    expect(execa).toHaveBeenCalledTimes(1);
  });

  it("ensurePython installs python3/venv/pip via apt when missing", async () => {
    execa.mockRejectedValueOnce(new Error("No module named venv"));
    execa.mockResolvedValueOnce({});
    const installed = await ensurePython(target);
    expect(installed).toBe(true);
    const [, args] = execa.mock.calls[1];
    expect(args[args.length - 1]).toContain("apt-get install -y python3 python3-venv python3-pip");
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
