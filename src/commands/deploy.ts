import { execa } from "execa";
import type { Command } from "commander";
import { loadGlobalConfig } from "../lib/config.js";
import { fail, info, success } from "../lib/logger.js";
import { createPM2Adapter } from "../lib/pm2.js";
import { findApp, scanAppsDir, toDetectedApp } from "../lib/scanner.js";
import type { DetectedApp } from "../types.js";

async function deployApp(app: DetectedApp): Promise<void> {
  info(`Deploying ${app.name}...`);

  info(`  Installing dependencies (${app.installCmd.join(" ")})...`);
  await execa(app.installCmd[0], app.installCmd.slice(1), {
    cwd: app.dir,
    stdio: "inherit",
  });

  if (app.buildCmd) {
    info(`  Building (${app.packageManager} ${app.buildCmd.join(" ")})...`);
    await execa(app.packageManager, app.buildCmd, {
      cwd: app.dir,
      stdio: "inherit",
    });
  }

  info("  Starting via PM2...");
  const pm2 = createPM2Adapter();
  await pm2.start(app);

  success(`${app.name} deployed`);
}

export function registerDeployCommand(program: Command): void {
  program
    .command("deploy [app]")
    .description("Install, build, and start one or all apps via PM2")
    .action(async (appName?: string) => {
      const config = loadGlobalConfig();

      if (appName) {
        const scanned = findApp(config.appsDir, appName);
        if (!scanned) {
          fail(`No app named "${appName}" found in ${config.appsDir}`);
          process.exitCode = 1;
          return;
        }
        await deployApp(toDetectedApp(scanned));
        return;
      }

      const { apps, warnings } = scanAppsDir(config.appsDir);
      for (const warning of warnings) {
        info(warning);
      }

      if (apps.length === 0) {
        info(`No apps found in ${config.appsDir}`);
        return;
      }

      for (const scanned of apps) {
        await deployApp(toDetectedApp(scanned));
      }
    });
}
