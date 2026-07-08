import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerDeployCommand } from "./commands/deploy.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerRestartCommand } from "./commands/restart.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerDoctorCommand } from "./commands/doctor.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("nodeploy")
    .description("A lightweight, self-hosted deployment CLI for Node.js apps")
    .version("0.1.0");

  registerInitCommand(program);
  registerDeployCommand(program);
  registerStatusCommand(program);
  registerRestartCommand(program);
  registerStopCommand(program);
  registerLogsCommand(program);
  registerDoctorCommand(program);

  return program;
}

export async function run(argv: string[]): Promise<void> {
  const program = createProgram();
  await program.parseAsync(argv);
}
