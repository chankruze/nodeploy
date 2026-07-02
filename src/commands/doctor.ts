import type { Command } from "commander";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check that your environment is ready for nodeploy")
    .action(() => {
      console.log("doctor: not yet implemented");
    });
}
