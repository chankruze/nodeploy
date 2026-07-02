import type { Command } from "commander";
import { loadGlobalConfig } from "../lib/config.js";
import { fail } from "../lib/logger.js";
import { createPM2Adapter } from "../lib/pm2.js";
import { findApp } from "../lib/scanner.js";

interface LogsOptions {
  lines?: string;
}

export function registerLogsCommand(program: Command): void {
  program
    .command("logs <app>")
    .description("Stream logs for an app via PM2")
    .option("--lines <count>", "number of lines to show")
    .action(async (appName: string, options: LogsOptions) => {
      const config = loadGlobalConfig();
      const scanned = findApp(config.appsDir, appName);

      if (!scanned) {
        fail(`No app named "${appName}" found in ${config.appsDir}`);
        process.exitCode = 1;
        return;
      }

      const name = scanned.appConfig?.name ?? scanned.dirName;
      const lines = options.lines ? Number(options.lines) : undefined;
      await createPM2Adapter().logs(name, { lines });
    });
}
