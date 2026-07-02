import type { Command } from "commander";
import { loadGlobalConfig } from "../lib/config.js";
import { info, printTable, warn } from "../lib/logger.js";
import { scanAppsDir, toDetectedApp } from "../lib/scanner.js";

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List detected apps and their status")
    .action(() => {
      const config = loadGlobalConfig();
      const { apps, warnings } = scanAppsDir(config.appsDir);

      for (const message of warnings) {
        warn(message);
      }

      if (apps.length === 0) {
        info(`No apps found in ${config.appsDir}`);
        return;
      }

      const rows = apps
        .map(toDetectedApp)
        .map((app) => [
          app.name,
          app.port !== undefined ? String(app.port) : "-",
          app.type,
          "not deployed",
        ]);

      printTable(rows, ["NAME", "PORT", "TYPE", "STATUS"]);
    });
}
