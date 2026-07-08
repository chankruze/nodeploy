import type { Command } from "commander";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import { loadDeployConfig, toSSHTarget } from "../lib/deployConfig.js";
import { info, warn } from "../lib/logger.js";
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
      const status = process_ ? STATUS_ICONS[process_.status] : "not deployed";

      info(`${config.service}: ${status}`);
    });
}
