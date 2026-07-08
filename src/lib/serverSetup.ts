import { withNvm } from "./remoteEnv.js";
import { sshExec } from "./ssh.js";
import type { SSHTarget } from "../types.js";

const NVM_VERSION = "v0.40.5";

async function commandExists(target: SSHTarget, bin: string): Promise<boolean> {
  try {
    await sshExec(target, withNvm(`command -v ${bin}`));
    return true;
  } catch {
    return false;
  }
}

/** Returns true if git had to be installed. Requires passwordless sudo. */
export async function ensureGit(target: SSHTarget): Promise<boolean> {
  if (await commandExists(target, "git")) return false;
  await sshExec(target, "sudo apt-get update && sudo apt-get install -y git", {
    stdio: "inherit",
  });
  return true;
}

/** Returns true if nvm+Node.js had to be installed. `nodeVersion` is an nvm
 * release spec, e.g. "22", "lts/*". Installs into $HOME/.nvm — no sudo needed. */
export async function ensureNode(
  target: SSHTarget,
  nodeVersion: string,
): Promise<boolean> {
  if (await commandExists(target, "node")) return false;

  const hasNvm = await commandExists(target, "nvm");
  if (!hasNvm) {
    await sshExec(
      target,
      `curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash`,
      { stdio: "inherit" },
    );
  }

  await sshExec(
    target,
    withNvm(`nvm install ${nodeVersion} && nvm alias default ${nodeVersion}`),
    { stdio: "inherit" },
  );
  return true;
}

/** Installs PM2 (via npm, no sudo) if missing. Returns true if it had to be installed. */
export async function ensurePM2(target: SSHTarget): Promise<boolean> {
  if (await commandExists(target, "pm2")) return false;
  await sshExec(target, withNvm("npm install -g pm2"), { stdio: "inherit" });
  return true;
}

/** Registers PM2 to start on boot via systemd. Requires passwordless sudo;
 * throws if unavailable so callers can treat it as a soft failure. */
export async function ensurePM2Startup(target: SSHTarget): Promise<void> {
  await sshExec(
    target,
    withNvm(
      `sudo env PATH=$PATH pm2 startup systemd -u ${target.user} --hp $HOME`,
    ),
    { stdio: "inherit" },
  );
}

/** Returns true if nginx had to be installed. Requires passwordless sudo. */
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
