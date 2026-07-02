import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findApp, scanAppsDir, toDetectedApp } from "../src/lib/scanner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures", "apps");

describe("scanAppsDir", () => {
  it("finds only directories that contain a package.json", () => {
    const { apps } = scanAppsDir(FIXTURES_DIR);
    const dirNames = apps.map((app) => app.dirName).sort();

    expect(dirNames).toContain("express-app");
    expect(dirNames).toContain("nest-app");
    expect(dirNames).toContain("next-app");
    expect(dirNames).toContain("configured-app");
    expect(dirNames).not.toContain("no-package-json");
  });

  it("skips directories with a malformed nodeploy.json and reports a warning", () => {
    const { apps, warnings } = scanAppsDir(FIXTURES_DIR);

    expect(apps.some((app) => app.dirName === "malformed-config-app")).toBe(
      false,
    );
    expect(
      warnings.some((w) => w.includes("malformed-config-app")),
    ).toBe(true);
  });

  it("attaches parsed appConfig when nodeploy.json is present", () => {
    const { apps } = scanAppsDir(FIXTURES_DIR);
    const configured = apps.find((app) => app.dirName === "configured-app");

    expect(configured?.appConfig).toEqual({ name: "custom-name", port: 4000 });
  });

  it("leaves appConfig null when nodeploy.json is absent", () => {
    const { apps } = scanAppsDir(FIXTURES_DIR);
    const express = apps.find((app) => app.dirName === "express-app");

    expect(express?.appConfig).toBeNull();
  });
});

describe("findApp", () => {
  it("matches by nodeploy.json name", () => {
    const app = findApp(FIXTURES_DIR, "custom-name");
    expect(app?.dirName).toBe("configured-app");
  });

  it("falls back to matching by directory name", () => {
    const app = findApp(FIXTURES_DIR, "express-app");
    expect(app?.dirName).toBe("express-app");
  });

  it("returns undefined when no app matches", () => {
    expect(findApp(FIXTURES_DIR, "does-not-exist")).toBeUndefined();
  });
});

describe("toDetectedApp", () => {
  it("resolves a fully detected app, preferring nodeploy.json name/port", () => {
    const configured = findApp(FIXTURES_DIR, "custom-name");
    if (!configured) throw new Error("fixture missing");

    const detected = toDetectedApp(configured);

    expect(detected.name).toBe("custom-name");
    expect(detected.port).toBe(4000);
    expect(detected.type).toBe("express");
    expect(detected.hasNodeployConfig).toBe(true);
  });

  it("falls back to the directory name and undefined port without nodeploy.json", () => {
    const express = findApp(FIXTURES_DIR, "express-app");
    if (!express) throw new Error("fixture missing");

    const detected = toDetectedApp(express);

    expect(detected.name).toBe("express-app");
    expect(detected.port).toBeUndefined();
    expect(detected.hasNodeployConfig).toBe(false);
  });
});
