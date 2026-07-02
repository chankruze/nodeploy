import fs from "node:fs";
import path from "node:path";
import { loadAppConfig } from "./appConfig.js";
import { detectAppType, resolveCommands } from "./detector.js";
import {
  detectPackageManager,
  resolveInstallCmd,
} from "./packageManager.js";
import type { AppConfig, DetectedApp, PackageJson } from "../types.js";

export interface ScannedApp {
  dir: string;
  dirName: string;
  pkg: PackageJson;
  appConfig: AppConfig | null;
}

export interface ScanResult {
  apps: ScannedApp[];
  warnings: string[];
}

export function scanAppsDir(appsDir: string): ScanResult {
  const entries = fs.readdirSync(appsDir, { withFileTypes: true });
  const apps: ScannedApp[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dirName = entry.name;
    const dir = path.join(appsDir, dirName);
    const packageJsonPath = path.join(dir, "package.json");

    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }

    let pkg: PackageJson;
    try {
      pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    } catch (error) {
      warnings.push(
        `skipped ${dirName}/: invalid package.json: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    let appConfig: AppConfig | null;
    try {
      appConfig = loadAppConfig(dir);
    } catch (error) {
      warnings.push(
        `skipped ${dirName}/: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    apps.push({ dir, dirName, pkg, appConfig });
  }

  return { apps, warnings };
}

export function findApp(appsDir: string, name: string): ScannedApp | undefined {
  const { apps } = scanAppsDir(appsDir);
  return apps.find(
    (app) => app.appConfig?.name === name || app.dirName === name,
  );
}

export function toDetectedApp(app: ScannedApp): DetectedApp {
  const type = detectAppType(app.pkg);
  const { buildCmd, startCmd } = resolveCommands(type, app.pkg);
  const packageManager = detectPackageManager(app.dir);

  return {
    name: app.appConfig?.name ?? app.dirName,
    dir: app.dir,
    port: app.appConfig?.port,
    type,
    packageManager,
    installCmd: resolveInstallCmd(packageManager),
    buildCmd,
    startCmd,
    pkg: app.pkg,
    hasNodeployConfig: app.appConfig !== null,
  };
}
