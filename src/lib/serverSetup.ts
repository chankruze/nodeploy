import { sshExec } from "./ssh.js";
import type { SSHTarget } from "../types.js";

async function commandExists(target: SSHTarget, bin: string): Promise<boolean> {
  try {
    await sshExec(target, `command -v ${bin}`);
    return true;
  } catch {
    return false;
  }
}

/** Returns true if git had to be installed. */
export async function ensureGit(target: SSHTarget): Promise<boolean> {
  if (await commandExists(target, "git")) return false;
  await sshExec(target, "sudo apt-get update && sudo apt-get install -y git", {
    stdio: "inherit",
  });
  return true;
}

/** Returns true if Node.js had to be installed. `nodeVersion` is a NodeSource
 * release line, e.g. "lts", "22", "24". */
export async function ensureNode(
  target: SSHTarget,
  nodeVersion: string,
): Promise<boolean> {
  if (await commandExists(target, "node")) return false;
  await sshExec(
    target,
    `curl -fsSL "https://deb.nodesource.com/setup_${nodeVersion}.x" | sudo -E bash - && sudo apt-get install -y nodejs`,
    { stdio: "inherit" },
  );
  return true;
}

/** Installs PM2 if missing and (re-)registers it to start on boot via systemd.
 * Returns true if PM2 had to be installed. */
export async function ensurePM2(target: SSHTarget): Promise<boolean> {
  const installed = await commandExists(target, "pm2");
  if (!installed) {
    await sshExec(target, "sudo npm install -g pm2", { stdio: "inherit" });
  }
  await sshExec(
    target,
    `sudo env PATH=$PATH:$(dirname $(which node)) pm2 startup systemd -u ${target.user} --hp $HOME`,
    { stdio: "inherit" },
  );
  return !installed;
}

/** Returns true if nginx had to be installed. */
export async function ensureNginx(target: SSHTarget): Promise<boolean> {
  if (await commandExists(target, "nginx")) return false;
  await sshExec(
    target,
    "sudo apt-get update && sudo apt-get install -y nginx && sudo systemctl enable --now nginx",
    { stdio: "inherit" },
  );
  return true;
}

export async function ensureDeployPath(
  target: SSHTarget,
  deployPath: string,
): Promise<void> {
  await sshExec(target, `mkdir -p "${deployPath}"`);
}
