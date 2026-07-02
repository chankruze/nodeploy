import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const {
  checkAppsDirWritable,
  checkMemory,
  checkNginx,
  checkPackageManager,
  checkPM2,
} = await import("../src/lib/doctorChecks.js");

describe("doctorChecks", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  it("checkPackageManager returns ok when the binary resolves", async () => {
    execa.mockResolvedValueOnce({ stdout: "10.0.0\n" });
    const result = await checkPackageManager("npm");
    expect(result).toEqual({ name: "npm", ok: true, message: "10.0.0" });
  });

  it("checkPackageManager marks pnpm as optional when missing", async () => {
    execa.mockRejectedValueOnce(new Error("not found"));
    const result = await checkPackageManager("pnpm");
    expect(result.ok).toBe(false);
    expect(result.optional).toBe(true);
  });

  it("checkPackageManager marks npm as required (not optional) when missing", async () => {
    execa.mockRejectedValueOnce(new Error("not found"));
    const result = await checkPackageManager("npm");
    expect(result.ok).toBe(false);
    expect(result.optional).toBe(false);
  });

  it("checkPM2 returns ok:true when pm2 is installed", async () => {
    execa.mockResolvedValueOnce({ stdout: "5.3.0\n" });
    const result = await checkPM2();
    expect(result).toEqual({ name: "PM2", ok: true, message: "5.3.0" });
  });

  it("checkPM2 returns ok:false and is required when pm2 is absent", async () => {
    execa.mockRejectedValueOnce(new Error("command not found"));
    const result = await checkPM2();
    expect(result.ok).toBe(false);
    expect(result.optional).toBeUndefined();
  });

  it("checkNginx is optional and does not fail hard when absent", async () => {
    execa.mockRejectedValueOnce(new Error("command not found"));
    const result = await checkNginx();
    expect(result.ok).toBe(false);
    expect(result.optional).toBe(true);
  });

  it("checkMemory reports free/total from os without shelling out", async () => {
    vi.spyOn(os, "freemem").mockReturnValue(2 * 1024 ** 3);
    vi.spyOn(os, "totalmem").mockReturnValue(8 * 1024 ** 3);

    const result = await checkMemory();

    expect(result.ok).toBe(true);
    expect(result.message).toContain("2.0GB free");
    expect(result.message).toContain("8.0GB total");
    expect(execa).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("checkAppsDirWritable fails when the directory does not exist", async () => {
    const result = await checkAppsDirWritable("/does/not/exist/nodeploy-test");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not exist");
  });
});
