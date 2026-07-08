import type { Command } from "commander";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import { loadDeployConfig, toSSHTarget } from "../lib/deployConfig.js";
import { formatBytes, formatUptime } from "../lib/format.js";
import { info, warn } from "../lib/logger.js";
import { isStaticSiteEnabled } from "../lib/nginx.js";
import { createPM2Adapter } from "../lib/pm2.js";
import type { PM2ProcessInfo } from "../types.js";

const STATUS_ICONS: Record<PM2ProcessInfo["status"], string> = {
  online: "🟢 online",
  stopped: "🔴 stopped",
  errored: "🔴 errored",
  stopping: "🟡 stopping",
  launching: "🟡 launching",
  unknown: "⚪ unknown",
};

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show the deployed status of the app in the current directory")
    .action(async () => {
      const config = loadDeployConfig(process.cwd(), DEPLOY_CONFIG_FILENAME);
      const target = toSSHTarget(config);

      let processes: PM2ProcessInfo[] = [];
      try {
        processes = await createPM2Adapter(target).list();
      } catch {
        warn("Could not reach PM2 on the server");
        return;
      }

      const process_ = processes.find((p) => p.name === config.service);
      if (!process_) {
        // Static apps (vite/cra) serve straight from nginx with no PM2
        // process, so an nginx site is the next place to check before
        // concluding the app was never deployed.
        if (config.proxy && (await isStaticSiteEnabled(target, config.service))) {
          info(`${config.service}: 🟢 online (static, served via nginx)`);
          return;
        }
        info(`${config.service}: not deployed`);
        return;
      }

      info(`${config.service}: ${STATUS_ICONS[process_.status]}`);
      info(`  pid:      ${process_.pid}`);
      info(`  cpu:      ${process_.cpu}%`);
      info(`  memory:   ${formatBytes(process_.memoryBytes)}`);
      info(`  uptime:   ${formatUptime(process_.uptimeMs)}`);
      info(`  restarts: ${process_.restarts}`);
    });
}
