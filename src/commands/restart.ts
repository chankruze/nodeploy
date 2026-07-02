import type { Command } from "commander";

export function registerRestartCommand(program: Command): void {
  program
    .command("restart <app>")
    .description("Restart an app via PM2")
    .action(() => {
      console.log("restart: not yet implemented");
    });
}
