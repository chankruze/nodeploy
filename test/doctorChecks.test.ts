import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeployConfig, SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const {
  checkDeployPathWritable,
  checkMemory,
  checkNginx,
  checkNode,
  checkPM2,
  checkPasswordlessSudo,
  checkSSHConnection,
  runAllChecks,
} = await import("../src/lib/doctorChecks.js");

const target: SSHTarget = {
  host: "203.0.113.10",
  user: "root",
  port: 22,
};

function makeConfig(overrides: Partial<DeployConfig> = {}): DeployConfig {
  return {
    service: "api",
    repo: "git@github.com:user/api.git",
    branch: "main",
    server: "203.0.113.10",
    ssh: { user: "root", port: 22 },
    deployPath: "~/apps/api",
    nodeVersion: "22",
    ...overrides,
  };
}

describe("doctorChecks", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  it("checkSSHConnection returns ok when the connection succeeds", async () => {
    execa.mockResolvedValueOnce({});
    const result = await checkSSHConnection(target);
    expect(result.ok).toBe(true);
  });

  it("checkSSHConnection returns ok:false when the connection fails", async () => {
    execa.mockRejectedValueOnce(new Error("connection refused"));
    const result = await checkSSHConnection(target);
    expect(result.ok).toBe(false);
  });

  it("checkNode returns ok when node resolves on the remote", async () => {
    execa.mockResolvedValueOnce({ stdout: "v20.0.0\n" });
    const result = await checkNode(target);
    expect(result).toEqual({ name: "node", ok: true, message: "v20.0.0" });
  });

  it("checkPM2 returns ok:false and is required when pm2 is absent remotely", async () => {
    execa.mockRejectedValueOnce(new Error("command not found"));
    const result = await checkPM2(target);
    expect(result.ok).toBe(false);
    expect(result.optional).toBeUndefined();
  });

  it("checkNginx is optional and does not fail hard when absent", async () => {
    execa.mockRejectedValueOnce(new Error("command not found"));
    const result = await checkNginx(target);
    expect(result.ok).toBe(false);
    expect(result.optional).toBe(true);
  });

  it("checkMemory parses the Mem: line from remote `free -h`", async () => {
    execa.mockResolvedValueOnce({
      stdout: "              total   used   free\nMem:    7.6Gi  2.1Gi  1.2Gi\n",
    });
    const result = await checkMemory(target);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Mem:");
  });

  it("checkDeployPathWritable fails when the remote command fails", async () => {
    execa.mockRejectedValueOnce(new Error("permission denied"));
    const result = await checkDeployPathWritable(target, "~/apps/api");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not writable");
  });

  it("checkPasswordlessSudo fails when sudo -n fails", async () => {
    execa.mockRejectedValueOnce(new Error("sudo: a password is required"));
    const result = await checkPasswordlessSudo(target);
    expect(result.ok).toBe(false);
  });

  it("runAllChecks short-circuits to just the connection check when SSH fails", async () => {
    execa.mockRejectedValueOnce(new Error("connection refused"));
    const results = await runAllChecks(makeConfig(), target);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
  });

  it("runAllChecks includes a sudo check only when proxy is configured", async () => {
    execa.mockResolvedValue({ stdout: "ok" });
    const results = await runAllChecks(
      makeConfig({ proxy: { host: "api.local" }, port: 3000 }),
      target,
    );
    expect(results.some((r) => r.name === "sudo")).toBe(true);
  });

  it("runAllChecks omits the sudo check when proxy is not configured", async () => {
    execa.mockResolvedValue({ stdout: "ok" });
    const results = await runAllChecks(makeConfig(), target);
    expect(results.some((r) => r.name === "sudo")).toBe(false);
  });
});
