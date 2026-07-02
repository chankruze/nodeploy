import type { Command } from "commander";

export function registerDeployCommand(program: Command): void {
  program
    .command("deploy [app]")
    .description("Install, build, and start one or all apps via PM2")
    .action(() => {
      console.log("deploy: not yet implemented");
    });
}
