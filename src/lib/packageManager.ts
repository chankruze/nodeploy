import fs from "node:fs";
import path from "node:path";
import type { PackageManagerName } from "../types.js";

export function detectPackageManager(appDir: string): PackageManagerName {
  const pnpmLockPath = path.join(appDir, "pnpm-lock.yaml");
  return fs.existsSync(pnpmLockPath) ? "pnpm" : "npm";
}

export function resolveInstallCmd(pm: PackageManagerName): string[] {
  return [pm, "install"];
}
