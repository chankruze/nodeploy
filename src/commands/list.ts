import type { Command } from "commander";

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List detected apps and their status")
    .action(() => {
      console.log("list: not yet implemented");
    });
}
