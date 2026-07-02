import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  validateGlobalConfig,
} from "../src/lib/config.js";

describe("validateGlobalConfig", () => {
  it("accepts a minimal valid config", () => {
    expect(validateGlobalConfig({ appsDir: "/apps" })).toEqual({
      appsDir: "/apps",
    });
  });

  it("accepts optional defaults.packageManager", () => {
    expect(
      validateGlobalConfig({
        appsDir: "/apps",
        defaults: { packageManager: "pnpm" },
      }),
    ).toEqual({ appsDir: "/apps", defaults: { packageManager: "pnpm" } });
  });

  it("throws when appsDir is missing", () => {
    expect(() => validateGlobalConfig({})).toThrow(/appsDir/);
  });

  it("throws when appsDir is not a string", () => {
    expect(() => validateGlobalConfig({ appsDir: 123 })).toThrow(/appsDir/);
  });

  it("throws when defaults.packageManager is invalid", () => {
    expect(() =>
      validateGlobalConfig({
        appsDir: "/apps",
        defaults: { packageManager: "yarn" },
      }),
    ).toThrow(/packageManager/);
  });

  it("throws on non-object input", () => {
    expect(() => validateGlobalConfig(null)).toThrow();
    expect(() => validateGlobalConfig("nope")).toThrow();
  });
});

describe("loadGlobalConfig / saveGlobalConfig", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodeploy-config-"));
    configPath = path.join(tmpDir, "nested", "config.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a default config when the file does not exist", () => {
    const config = loadGlobalConfig(configPath);
    expect(config.appsDir).toBeTruthy();
  });

  it("saves and reloads a config, creating parent directories", () => {
    saveGlobalConfig({ appsDir: "/my/apps" }, configPath);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(loadGlobalConfig(configPath)).toEqual({ appsDir: "/my/apps" });
  });
});
