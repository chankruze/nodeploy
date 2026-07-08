import { detectAppType, resolveCommands } from "./detector.js";
import { detectRemotePackageManager, resolveInstallCmd } from "./packageManager.js";
import { sshExec } from "./ssh.js";
import type { DeployConfig, PackageJson, RemoteApp, SSHTarget } from "../types.js";

export async function resolveRemoteApp(
  target: SSHTarget,
  config: DeployConfig,
): Promise<RemoteApp> {
  const { stdout } = await sshExec(
    target,
    `cat "${config.deployPath}/package.json"`,
  );
  const pkg: PackageJson = JSON.parse(stdout);

  const type = detectAppType(pkg);
  const { buildCmd, startCmd } = resolveCommands(type, pkg);
  const packageManager = await detectRemotePackageManager(
    target,
    config.deployPath,
  );

  return {
    name: config.service,
    dir: config.deployPath,
    type,
    packageManager,
    installCmd: resolveInstallCmd(packageManager),
    buildCmd,
    startCmd,
    startArgs: config.startArgs ?? [],
  };
}
