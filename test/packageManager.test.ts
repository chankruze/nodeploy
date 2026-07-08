import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const { detectRemotePackageManager, resolveInstallCmd } = await import(
  "../src/lib/packageManager.js"
);

const target: SSHTarget = {
  host: "203.0.113.10",
  user: "root",
  port: 22,
};

describe("detectRemotePackageManager", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  it("returns pnpm when the remote pnpm-lock.yaml exists", async () => {
    execa.mockResolvedValueOnce({});
    const result = await detectRemotePackageManager(target, "~/apps/api");
    expect(result).toBe("pnpm");
    expect(execa).toHaveBeenCalledWith(
      "ssh",
      ["-p", "22", "root@203.0.113.10", 'test -f "~/apps/api/pnpm-lock.yaml"'],
      {},
    );
  });

  it("returns npm when the remote pnpm-lock.yaml does not exist", async () => {
    execa.mockRejectedValueOnce(new Error("exit 1"));
    const result = await detectRemotePackageManager(target, "~/apps/api");
    expect(result).toBe("npm");
  });
});

describe("resolveInstallCmd", () => {
  it("resolves npm install", () => {
    expect(resolveInstallCmd("npm")).toEqual(["npm", "install"]);
  });

  it("resolves pnpm install", () => {
    expect(resolveInstallCmd("pnpm")).toEqual(["pnpm", "install"]);
  });
});
