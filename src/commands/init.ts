import type { Command } from "commander";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize nodeploy global configuration")
    .option("--apps-dir <path>", "directory containing your apps")
    .option("--force", "overwrite existing config", false)
    .action(() => {
      console.log("init: not yet implemented");
    });
}
