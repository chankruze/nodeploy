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

/** Resolves a `$HOME`/`~`-relative remote path to an absolute one. Needed
 * wherever a path is written into a config file nginx reads directly — nginx
 * doesn't run through a shell, so it has no way to expand either form itself. */
export async function resolveHomePath(
  target: SSHTarget,
  remotePath: string,
): Promise<string> {
  if (!remotePath.startsWith("$HOME") && !remotePath.startsWith("~")) {
    return remotePath;
  }
  const { stdout } = await sshExec(target, "echo $HOME");
  const home = stdout.trim();
  return remotePath.replace(/^(\$HOME|~)/, home);
}

export { buildSSHArgs };
