import os from "node:os";
import path from "node:path";

export const DEFAULT_APPS_DIR = path.join(os.homedir(), "apps");

export const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".nodeploy");

export const DEFAULT_CONFIG_PATH = path.join(
  DEFAULT_CONFIG_DIR,
  "config.json",
);

export const APP_CONFIG_FILENAME = "nodeploy.json";
