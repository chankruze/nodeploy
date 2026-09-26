import { Command } from "commander";
// Bundled into dist/cli.js at build time (only this field), so --version
// can't drift from package.json again.
import { version } from "../package.json";
import { registerInitCommand } from "./commands/init.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerDeployCommand } from "./commands/deploy.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerRestartCommand } from "./commands/restart.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerEdgeCommand } from "./commands/edge.js";
import { registerRemoveCommand } from "./commands/remove.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("nodeploy")
    .description("A lightweight, self-hosted deployment CLI for Node.js apps")
    .version(version);

  registerInitCommand(program);
  registerSetupCommand(program);
  registerDeployCommand(program);
  registerStatusCommand(program);
  registerRestartCommand(program);
  registerStopCommand(program);
  registerLogsCommand(program);
  registerDoctorCommand(program);
  registerRemoveCommand(program);
  registerEdgeCommand(program);

  return program;
}

export async function run(argv: string[]): Promise<void> {
  const program = createProgram();
  await program.parseAsync(argv);
}
