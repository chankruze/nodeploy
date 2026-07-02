import type { Command } from "commander";
import { loadGlobalConfig } from "../lib/config.js";
import { fail, success } from "../lib/logger.js";
import { createPM2Adapter } from "../lib/pm2.js";
import { findApp } from "../lib/scanner.js";

export function registerStopCommand(program: Command): void {
  program
    .command("stop <app>")
    .description("Stop an app via PM2")
    .action(async (appName: string) => {
      const config = loadGlobalConfig();
      const scanned = findApp(config.appsDir, appName);

      if (!scanned) {
        fail(`No app named "${appName}" found in ${config.appsDir}`);
        process.exitCode = 1;
        return;
      }

      const name = scanned.appConfig?.name ?? scanned.dirName;
      await createPM2Adapter().stop(name);
      success(`${name} stopped`);
    });
}
