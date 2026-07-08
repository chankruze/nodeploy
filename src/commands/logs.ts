import type { Command } from "commander";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import { loadDeployConfig, toSSHTarget } from "../lib/deployConfig.js";
import { fail } from "../lib/logger.js";
import { isStaticSiteEnabled } from "../lib/nginx.js";
import { createPM2Adapter } from "../lib/pm2.js";

interface LogsOptions {
  lines?: string;
}

export function registerLogsCommand(program: Command): void {
  program
    .command("logs")
    .description("Stream logs for the app in the current directory via PM2")
    .option("--lines <count>", "number of lines to show")
    .action(async (options: LogsOptions) => {
      const config = loadDeployConfig(process.cwd(), DEPLOY_CONFIG_FILENAME);
      const target = toSSHTarget(config);

      const processes = await createPM2Adapter(target).list();
      const isPM2Managed = processes.some((p) => p.name === config.service);

      if (!isPM2Managed && (await isStaticSiteEnabled(target, config.service))) {
        fail(
          `${config.service} is a static app served directly by nginx — there's no PM2 process to stream logs from. Check /var/log/nginx/access.log and error.log on the server instead.`,
        );
        process.exitCode = 1;
        return;
      }

      const lines = options.lines ? Number(options.lines) : undefined;
      await createPM2Adapter(target).logs(config.service, { lines });
    });
}
