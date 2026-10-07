import { sshExec } from "./ssh.js";
import type { SSHTarget } from "../types.js";

/** Whether anything on the server listens on `port` — for runtime: external
 * apps, the only sign nodeploy has that the app itself is up, since another
 * tool runs it. `ss` needs no sudo for listening sockets (only for -p). */
export async function isPortListening(
  target: SSHTarget,
  port: number,
): Promise<boolean> {
  try {
    const { stdout } = await sshExec(target, `ss -Hltn "sport = :${port}"`);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
