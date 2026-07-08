import type { Command } from "commander";
import { execa } from "execa";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import { loadDeployConfig, toSSHTarget } from "../lib/deployConfig.js";
import { runAllChecks } from "../lib/doctorChecks.js";
import { fail, success, warn } from "../lib/logger.js";

async function checkLocalSSH(): Promise<boolean> {
  try {
    await execa("ssh", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check that your local machine and server are ready for nodeploy")
    .action(async () => {
      if (!(await checkLocalSSH())) {
        fail("ssh not found on your local PATH");
        process.exitCode = 1;
        return;
      }
      success("ssh: available locally");

      const config = loadDeployConfig(process.cwd(), DEPLOY_CONFIG_FILENAME);
      const target = toSSHTarget(config);

      const results = await runAllChecks(config, target);

      let hasRequiredFailure = false;

      for (const result of results) {
        const line = `${result.name}: ${result.message}`;
        if (result.ok) {
          success(line);
        } else if (result.optional) {
          warn(line);
        } else {
          fail(line);
          hasRequiredFailure = true;
        }
      }

      if (hasRequiredFailure) {
        process.exitCode = 1;
      }
    });
}
