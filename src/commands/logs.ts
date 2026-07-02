import type { Command } from "commander";

export function registerLogsCommand(program: Command): void {
  program
    .command("logs <app>")
    .description("Stream logs for an app via PM2")
    .option("--lines <count>", "number of lines to show")
    .action(() => {
      console.log("logs: not yet implemented");
    });
}
