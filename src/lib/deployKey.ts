import { sshExec } from "./ssh.js";
import type { SSHTarget } from "../types.js";

/**
 * Extracts the SSH host from a `git@host:path` (scp-like) or `ssh://user@host/path`
 * repo URL. Returns null for non-SSH URLs (e.g. `https://`), which need no deploy key.
 */
export function parseGitSSHHost(repo: string): string | null {
  const scpMatch = repo.match(/^[^@\s]+@([^:\s]+):/);
  if (scpMatch) return scpMatch[1];

  const uriMatch = repo.match(/^ssh:\/\/[^@\s]+@([^/:\s]+)/);
  if (uriMatch) return uriMatch[1];

  return null;
}

/** Path to this app's dedicated deploy key on the server. Uses $HOME (not `~`,
 * which doesn't expand inside the double-quoted remote commands this is used in). */
export function deployKeyPath(service: string): string {
  return `$HOME/.ssh/${service}_deploy_key`;
}

export interface DeployKeyResult {
  publicKey: string;
  created: boolean;
}

/**
 * Ensures a dedicated ed25519 deploy key exists for this app on the server, and
 * that `host`'s SSH host key is trusted. Reuses an existing key if one was already
 * generated for this service; only creates a new one the first time.
 */
export async function ensureDeployKey(
  target: SSHTarget,
  service: string,
  host: string,
): Promise<DeployKeyResult> {
  const keyPath = deployKeyPath(service);

  const remoteCommand = [
    "mkdir -p $HOME/.ssh && chmod 700 $HOME/.ssh;",
    `ssh-keygen -F "${host}" > /dev/null 2>&1 || ssh-keyscan -H "${host}" >> $HOME/.ssh/known_hosts 2>/dev/null;`,
    `if [ -f "${keyPath}.pub" ]; then`,
    `echo "EXISTS"; cat "${keyPath}.pub";`,
    "else",
    `ssh-keygen -t ed25519 -C "${service}-deploy-key" -f "${keyPath}" -N "" > /dev/null; echo "CREATED"; cat "${keyPath}.pub";`,
    "fi",
  ].join(" ");

  const { stdout } = await sshExec(target, remoteCommand);
  const lines = stdout.trim().split("\n");
  const marker = lines[0]?.trim();
  const publicKey = lines.slice(1).join("\n").trim();

  return { publicKey, created: marker === "CREATED" };
}
