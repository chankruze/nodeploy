import fs from "node:fs";
import path from "node:path";
import { APP_CONFIG_FILENAME } from "../constants.js";
import type { AppConfig } from "../types.js";

export function validateAppConfig(raw: unknown, appDir: string): AppConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Invalid nodeploy.json in ${appDir}: must be a JSON object`);
  }

  const candidate = raw as Record<string, unknown>;

  if (typeof candidate.name !== "string" || candidate.name.length === 0) {
    throw new Error(
      `Invalid nodeploy.json in ${appDir}: "name" must be a non-empty string`,
    );
  }

  if (typeof candidate.port !== "number" || !Number.isInteger(candidate.port)) {
    throw new Error(
      `Invalid nodeploy.json in ${appDir}: "port" must be an integer`,
    );
  }

  if (candidate.port < 1 || candidate.port > 65535) {
    throw new Error(
      `Invalid nodeploy.json in ${appDir}: "port" must be between 1 and 65535`,
    );
  }

  const config: AppConfig = { name: candidate.name, port: candidate.port };

  if (candidate.env !== undefined) {
    if (typeof candidate.env !== "object" || candidate.env === null) {
      throw new Error(`Invalid nodeploy.json in ${appDir}: "env" must be an object`);
    }
    config.env = candidate.env as Record<string, string>;
  }

  return config;
}

export function loadAppConfig(appDir: string): AppConfig | null {
  const configPath = path.join(appDir, APP_CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    return null;
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  return validateAppConfig(raw, appDir);
}
