import type { Command } from "commander";
import { loadGlobalConfig } from "../lib/config.js";
import { info, printTable, warn } from "../lib/logger.js";
import { createPM2Adapter } from "../lib/pm2.js";
import { scanAppsDir, toDetectedApp } from "../lib/scanner.js";
import type { PM2ProcessInfo } from "../types.js";

const STATUS_ICONS: Record<PM2ProcessInfo["status"], string> = {
  online: "🟢 online",
  stopped: "🔴 stopped",
  errored: "🔴 errored",
  stopping: "🟡 stopping",
  launching: "🟡 launching",
  unknown: "⚪ unknown",
};

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List detected apps and their status")
    .action(async () => {
      const config = loadGlobalConfig();
      const { apps, warnings } = scanAppsDir(config.appsDir);

      for (const message of warnings) {
        warn(message);
      }

      if (apps.length === 0) {
        info(`No apps found in ${config.appsDir}`);
        return;
      }

      let pm2Processes: PM2ProcessInfo[] = [];
      try {
        pm2Processes = await createPM2Adapter().list();
      } catch {
        warn("Could not reach PM2 — showing apps without live status");
      }

      const rows = apps
        .map(toDetectedApp)
        .map((app) => {
          const process = pm2Processes.find((p) => p.name === app.name);
          const status = process
            ? STATUS_ICONS[process.status]
            : "not deployed";
          return [
            app.name,
            app.port !== undefined ? String(app.port) : "-",
            app.type,
            status,
          ];
        });

      printTable(rows, ["NAME", "PORT", "TYPE", "STATUS"]);
    });
}
