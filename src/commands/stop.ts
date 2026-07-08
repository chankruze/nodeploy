import type { Command } from "commander";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import { loadDeployConfig, toSSHTarget } from "../lib/deployConfig.js";
import { success } from "../lib/logger.js";
import { createPM2Adapter } from "../lib/pm2.js";

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop the app in the current directory via PM2")
    .action(async () => {
      const config = loadDeployConfig(process.cwd(), DEPLOY_CONFIG_FILENAME);
      const target = toSSHTarget(config);

      await createPM2Adapter(target).stop(config.service);
      success(`${config.service} stopped`);
    });
}
