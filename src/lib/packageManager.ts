import { sshExec } from "./ssh.js";
import type { PackageManagerName, SSHTarget } from "../types.js";

export async function detectRemotePackageManager(
  target: SSHTarget,
  deployPath: string,
): Promise<PackageManagerName> {
  try {
    await sshExec(target, `test -f "${deployPath}/pnpm-lock.yaml"`);
    return "pnpm";
  } catch {
    return "npm";
  }
}

export function resolveInstallCmd(pm: PackageManagerName): string[] {
  return [pm, "install"];
}
