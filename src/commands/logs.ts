import type { Command } from "commander";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import { loadDeployConfig, toSSHTarget } from "../lib/deployConfig.js";
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

      const lines = options.lines ? Number(options.lines) : undefined;
      await createPM2Adapter(target).logs(config.service, { lines });
    });
}
