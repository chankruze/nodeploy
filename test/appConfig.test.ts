import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig, validateAppConfig } from "../src/lib/appConfig.js";

describe("validateAppConfig", () => {
  it("accepts a minimal valid config", () => {
    expect(validateAppConfig({ name: "api", port: 3000 }, "/apps/api")).toEqual({
      name: "api",
      port: 3000,
    });
  });

  it("accepts optional env", () => {
    expect(
      validateAppConfig(
        { name: "api", port: 3000, env: { NODE_ENV: "production" } },
        "/apps/api",
      ),
    ).toEqual({ name: "api", port: 3000, env: { NODE_ENV: "production" } });
  });

  it("throws when name is missing", () => {
    expect(() => validateAppConfig({ port: 3000 }, "/apps/api")).toThrow(/name/);
  });

  it("throws when port is missing", () => {
    expect(() => validateAppConfig({ name: "api" }, "/apps/api")).toThrow(/port/);
  });

  it("throws when port is not an integer", () => {
    expect(() =>
      validateAppConfig({ name: "api", port: "3000" }, "/apps/api"),
    ).toThrow(/port/);
  });

  it("throws when port is out of range", () => {
    expect(() =>
      validateAppConfig({ name: "api", port: 70000 }, "/apps/api"),
    ).toThrow(/port/);
  });
});

describe("loadAppConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodeploy-appconfig-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when nodeploy.json is absent", () => {
    expect(loadAppConfig(tmpDir)).toBeNull();
  });

  it("loads and validates an existing nodeploy.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "nodeploy.json"),
      JSON.stringify({ name: "api", port: 3001 }),
    );
    expect(loadAppConfig(tmpDir)).toEqual({ name: "api", port: 3001 });
  });

  it("throws a descriptive error for a malformed nodeploy.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "nodeploy.json"),
      JSON.stringify({ name: "api" }),
    );
    expect(() => loadAppConfig(tmpDir)).toThrow(/port/);
  });
});
