import type { Command } from "commander";
import { loadGlobalConfig } from "../lib/config.js";
import { runAllChecks } from "../lib/doctorChecks.js";
import { fail, success, warn } from "../lib/logger.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check that your environment is ready for nodeploy")
    .action(async () => {
      const config = loadGlobalConfig();
      const results = await runAllChecks(config);

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
