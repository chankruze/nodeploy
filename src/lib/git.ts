import { sshExec } from "./ssh.js";
import type { SSHTarget } from "../types.js";

export interface EnsureRepoOptions {
  repo: string;
  branch: string;
  deployPath: string;
}

export async function ensureRepo(
  target: SSHTarget,
  opts: EnsureRepoOptions,
): Promise<void> {
  const { repo, branch, deployPath } = opts;

  const remoteCommand = [
    `if [ -d "${deployPath}/.git" ]; then`,
    `  cd "${deployPath}" && git fetch origin "${branch}" && git reset --hard "origin/${branch}";`,
    "else",
    `  mkdir -p "${deployPath}" && git clone --branch "${branch}" "${repo}" "${deployPath}";`,
    "fi",
  ].join(" ");

  await sshExec(target, remoteCommand, { stdio: "inherit" });
}

