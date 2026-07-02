import fs from "node:fs";
import path from "node:path";
import { DEFAULT_APPS_DIR, DEFAULT_CONFIG_PATH } from "../constants.js";
import type { GlobalConfig } from "../types.js";

export function validateGlobalConfig(raw: unknown): GlobalConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("config must be a JSON object");
  }

  const candidate = raw as Record<string, unknown>;

  if (typeof candidate.appsDir !== "string" || candidate.appsDir.length === 0) {
    throw new Error("config.appsDir must be a non-empty string");
  }

  const config: GlobalConfig = { appsDir: candidate.appsDir };

  if (candidate.defaults !== undefined) {
    if (typeof candidate.defaults !== "object" || candidate.defaults === null) {
      throw new Error("config.defaults must be an object");
    }
    const defaults = candidate.defaults as Record<string, unknown>;
    if (
      defaults.packageManager !== undefined &&
      !["npm", "pnpm", "auto"].includes(defaults.packageManager as string)
    ) {
      throw new Error(
        "config.defaults.packageManager must be one of npm, pnpm, auto",
      );
    }
    config.defaults = defaults as GlobalConfig["defaults"];
  }

  return config;
}

export function loadGlobalConfig(
  configPath: string = DEFAULT_CONFIG_PATH,
): GlobalConfig {
  if (!fs.existsSync(configPath)) {
    return { appsDir: DEFAULT_APPS_DIR };
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  return validateGlobalConfig(raw);
}

export function saveGlobalConfig(
  config: GlobalConfig,
  configPath: string = DEFAULT_CONFIG_PATH,
): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
