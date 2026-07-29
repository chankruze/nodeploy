import { detectAppType, resolveCommands, resolveStaticDir } from "./detector.js";
import { detectRemotePackageManager, resolveInstallCmd } from "./packageManager.js";
import {
  detectPythonAppType,
  fetchPythonManifest,
  resolvePythonInstallCmd,
} from "./pythonDetector.js";
import { sshExec } from "./ssh.js";
import type { DeployConfig, PackageJson, RemoteApp, SSHTarget } from "../types.js";

async function resolveNodeRemoteApp(
  target: SSHTarget,
  config: DeployConfig,
): Promise<RemoteApp> {
  const { stdout } = await sshExec(
    target,
    `cat "${config.deployPath}/package.json"`,
  );
  const pkg: PackageJson = JSON.parse(stdout);

  const type = detectAppType(pkg);
  const { buildCmd, startCmd } = resolveCommands(type, pkg, config.startScript);
  const packageManager = await detectRemotePackageManager(
    target,
    config.deployPath,
  );

  return {
    name: config.service,
    dir: config.deployPath,
    type,
    runtime: "node",
    packageManager,
    installCmd: resolveInstallCmd(packageManager),
    buildCmd,
    startCmd,
    startArgs: config.startArgs ?? [],
    staticDir: resolveStaticDir(type),
  };
}

async function resolvePythonRemoteApp(
  target: SSHTarget,
  config: DeployConfig,
): Promise<RemoteApp> {
  // Validated as required for runtime: python in deployConfig.ts.
  const entry = config.entry as string;
  const venvPath = `${config.deployPath}/.venv`;

  const manifest = await fetchPythonManifest(target, config.deployPath);
  const type = detectPythonAppType(manifest);

  return {
    name: config.service,
    dir: config.deployPath,
    type,
    runtime: "python",
    packageManager: "pip",
    // Every Python app gets its own venv, even with no dependencies to install.
    installCmd: resolvePythonInstallCmd(manifest, venvPath),
    buildCmd: null,
    startCmd: [entry],
    startArgs: config.startArgs ?? [],
    staticDir: null,
    interpreter: `${venvPath}/bin/python3`,
    env: config.port ? { PORT: String(config.port) } : undefined,
  };
}

export async function resolveRemoteApp(
  target: SSHTarget,
  config: DeployConfig,
): Promise<RemoteApp> {
  return config.runtime === "python"
    ? resolvePythonRemoteApp(target, config)
    : resolveNodeRemoteApp(target, config);
}
