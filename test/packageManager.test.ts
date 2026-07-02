import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectPackageManager,
  resolveInstallCmd,
} from "../src/lib/packageManager.js";

describe("detectPackageManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodeploy-pm-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns pnpm when pnpm-lock.yaml exists", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });

  it("returns npm when no pnpm-lock.yaml exists", () => {
    expect(detectPackageManager(tmpDir)).toBe("npm");
  });

  it("returns npm when only package-lock.json exists", () => {
    fs.writeFileSync(path.join(tmpDir, "package-lock.json"), "");
    expect(detectPackageManager(tmpDir)).toBe("npm");
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
