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

export async function ensureRepo(
  target: SSHTarget,
  opts: EnsureRepoOptions,
): Promise<void> {
  const { repo, branch, deployPath, service } = opts;

  const sshHost = parseGitSSHHost(repo);
  const exportGitSsh = sshHost
    ? `export GIT_SSH_COMMAND='ssh -i "${deployKeyPath(service)}" -o IdentitiesOnly=yes'; `
    : "";

  const remoteCommand = [
    exportGitSsh + `if [ -d "${deployPath}/.git" ]; then`,
    `  cd "${deployPath}" && git fetch origin "${branch}" && git reset --hard "origin/${branch}";`,
    "else",
    `  mkdir -p "${deployPath}" && git clone --branch "${branch}" "${repo}" "${deployPath}";`,
    "fi",
  ].join(" ");

  await sshExec(target, remoteCommand, { stdio: "inherit" });
}
