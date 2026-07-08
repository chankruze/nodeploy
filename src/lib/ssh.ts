import { execa } from "execa";
import type { SSHTarget } from "../types.js";

function buildSSHArgs(target: SSHTarget): string[] {
  const args: string[] = ["-p", String(target.port)];

  for (const key of target.keys ?? []) {
    args.push("-i", key);
  }

  args.push(`${target.user}@${target.host}`);
  return args;
}

export interface SSHExecOptions {
  stdio?: "inherit";
  input?: string;
}

export async function sshExec(
  target: SSHTarget,
  remoteCommand: string,
  opts: SSHExecOptions = {},
): Promise<{ stdout: string }> {
  const args = [...buildSSHArgs(target), remoteCommand];
  const execaOpts: { stdio?: "inherit"; input?: string } = {};
  if (opts.stdio) execaOpts.stdio = opts.stdio;
  if (opts.input !== undefined) execaOpts.input = opts.input;

  const result = await execa("ssh", args, execaOpts);
  return { stdout: result.stdout ?? "" };
}

export async function sshTest(target: SSHTarget): Promise<boolean> {
  try {
    await sshExec(target, "true");
    return true;
  } catch {
    return false;
  }
}

export { buildSSHArgs };
