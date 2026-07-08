import type { Command } from "commander";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import { loadDeployConfig, toSSHTarget } from "../lib/deployConfig.js";
import { fail, success } from "../lib/logger.js";
import { isStaticSiteEnabled } from "../lib/nginx.js";
import { createPM2Adapter } from "../lib/pm2.js";

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop the app in the current directory via PM2")
    .action(async () => {
      const config = loadDeployConfig(process.cwd(), DEPLOY_CONFIG_FILENAME);
      const target = toSSHTarget(config);

      const processes = await createPM2Adapter(target).list();
      const isPM2Managed = processes.some((p) => p.name === config.service);

      if (!isPM2Managed && (await isStaticSiteEnabled(target, config.service))) {
        fail(
          `${config.service} is a static app served directly by nginx — there's no PM2 process to stop. Remove /etc/nginx/sites-enabled/${config.service}.conf on the server to take it down.`,
        );
        process.exitCode = 1;
        return;
      }

      await createPM2Adapter(target).stop(config.service);
      success(`${config.service} stopped`);
    });
}
