import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { DEFAULT_APPS_DIR, DEFAULT_CONFIG_PATH } from "../constants.js";
import { loadGlobalConfig, saveGlobalConfig } from "../lib/config.js";
import { info, success } from "../lib/logger.js";

interface InitOptions {
  appsDir?: string;
  force?: boolean;
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize nodeploy global configuration")
    .option("--apps-dir <path>", "directory containing your apps")
    .option("--force", "overwrite existing config", false)
    .action((options: InitOptions) => {
      if (fs.existsSync(DEFAULT_CONFIG_PATH) && !options.force) {
        const existing = loadGlobalConfig();
        info(`Config already exists at ${DEFAULT_CONFIG_PATH}`);
        info(`  appsDir: ${existing.appsDir}`);
        info("Pass --force to overwrite.");
        return;
      }

      const appsDir = path.resolve(
        expandHome(options.appsDir ?? DEFAULT_APPS_DIR),
      );

      fs.mkdirSync(appsDir, { recursive: true });
      saveGlobalConfig({ appsDir });

      success(`Initialized nodeploy config at ${DEFAULT_CONFIG_PATH}`);
      info(`  appsDir: ${appsDir}`);
      info(
        "Add an optional nodeploy.json to any app folder, then run `nodeploy deploy`.",
      );
    });
}
