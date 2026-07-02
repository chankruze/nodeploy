import type { Command } from "commander";

export function registerStopCommand(program: Command): void {
  program
    .command("stop <app>")
    .description("Stop an app via PM2")
    .action(() => {
      console.log("stop: not yet implemented");
    });
}
