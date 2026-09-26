import { deployKeyPath, parseGitSSHHost } from "./deployKey.js";
import { sshExec } from "./ssh.js";
import type { SSHTarget } from "../types.js";

export interface EnsureRepoOptions {
  repo: string;
  branch: string;
  deployPath: string;
  /** PM2/nginx service name — used to look up this app's dedicated deploy key. */
  service: string;
}

/** Shell prefix making git on the server authenticate with this app's own
 * deploy key, for SSH repo URLs (empty for https://, which needs none). */
export function gitSshEnv(repo: string, service: string): string {
  return parseGitSSHHost(repo)
    ? `export GIT_SSH_COMMAND='ssh -i "${deployKeyPath(service)}" -o IdentitiesOnly=yes'; `
    : "";
}

export async function ensureRepo(
  target: SSHTarget,
  opts: EnsureRepoOptions,
): Promise<void> {
  const { repo, branch, deployPath, service } = opts;
  const exportGitSsh = gitSshEnv(repo, service);

  const remoteCommand = [
    exportGitSsh + `if [ -d "${deployPath}/.git" ]; then`,
    `  cd "${deployPath}" && git fetch origin "${branch}" && git reset --hard "origin/${branch}";`,
    "else",
    `  mkdir -p "${deployPath}" && git clone --branch "${branch}" "${repo}" "${deployPath}";`,
    "fi",
  ].join(" ");

  await sshExec(target, remoteCommand, { stdio: "inherit" });
}

/** The commit `branch` currently points to on the remote, asked from the
 * server (with its deploy key) without fetching anything. Null if the
 * server can't reach the remote or the branch doesn't exist. */
export async function remoteBranchHead(
  target: SSHTarget,
  opts: Omit<EnsureRepoOptions, "deployPath">,
): Promise<string | null> {
  try {
    const { stdout } = await sshExec(
      target,
      `${gitSshEnv(opts.repo, opts.service)}git ls-remote "${opts.repo}" "refs/heads/${opts.branch}"`,
    );
    const commit = stdout.trim().split(/\s+/)[0] ?? "";
    return /^[0-9a-f]{40}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}
