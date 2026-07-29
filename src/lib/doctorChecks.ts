import { withNvm } from "./remoteEnv.js";
import { sshExec, sshTest } from "./ssh.js";
import type { DeployConfig, DoctorCheckResult, SSHTarget } from "../types.js";

export async function checkSSHConnection(
  target: SSHTarget,
): Promise<DoctorCheckResult> {
  const ok = await sshTest(target);
  return ok
    ? { name: "SSH", ok: true, message: `connected to ${target.host}` }
    : {
        name: "SSH",
        ok: false,
        message: `could not connect to ${target.user}@${target.host}:${target.port}`,
      };
}

async function checkRemoteBinary(
  target: SSHTarget,
  name: string,
  versionArgs: string,
  opts: { optional?: boolean; hint?: string } = {},
): Promise<DoctorCheckResult> {
  try {
    const { stdout } = await sshExec(target, withNvm(`${name} ${versionArgs}`));
    return { name, ok: true, message: stdout.trim() };
  } catch {
    return {
      name,
      ok: false,
      message: opts.hint ?? `${name} not found on remote PATH`,
      optional: opts.optional,
    };
  }
}

export function checkNode(target: SSHTarget): Promise<DoctorCheckResult> {
  return checkRemoteBinary(target, "node", "--version");
}

export function checkNpm(target: SSHTarget): Promise<DoctorCheckResult> {
  return checkRemoteBinary(target, "npm", "--version");
}

export function checkPnpm(target: SSHTarget): Promise<DoctorCheckResult> {
  return checkRemoteBinary(target, "pnpm", "--version", { optional: true });
}

export function checkPM2(target: SSHTarget): Promise<DoctorCheckResult> {
  return checkRemoteBinary(target, "pm2", "--version", {
    hint: "pm2 not found on remote PATH — install with `npm i -g pm2`",
  });
}

export function checkPython(target: SSHTarget): Promise<DoctorCheckResult> {
  return checkRemoteBinary(target, "python3", "--version", {
    hint: "python3 not found on remote PATH — required for runtime: python",
  });
}

export function checkNginx(target: SSHTarget): Promise<DoctorCheckResult> {
  return checkRemoteBinary(target, "nginx", "-v", {
    optional: true,
    hint: "nginx not found on remote PATH (optional unless using proxy)",
  });
}

export async function checkDiskSpace(
  target: SSHTarget,
): Promise<DoctorCheckResult> {
  try {
    const { stdout } = await sshExec(target, "df -h $HOME");
    const lastLine = stdout.trim().split("\n").pop() ?? "";
    return { name: "Disk", ok: true, message: lastLine.trim(), optional: true };
  } catch (error) {
    return {
      name: "Disk",
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      optional: true,
    };
  }
}

export async function checkMemory(
  target: SSHTarget,
): Promise<DoctorCheckResult> {
  try {
    const { stdout } = await sshExec(target, "free -h");
    const memLine = stdout
      .trim()
      .split("\n")
      .find((line) => line.startsWith("Mem:"));
    return {
      name: "RAM",
      ok: true,
      message: memLine?.trim() ?? stdout.trim(),
      optional: true,
    };
  } catch (error) {
    return {
      name: "RAM",
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      optional: true,
    };
  }
}

export async function checkDeployPathWritable(
  target: SSHTarget,
  deployPath: string,
): Promise<DoctorCheckResult> {
  try {
    await sshExec(
      target,
      `mkdir -p "${deployPath}" && test -w "${deployPath}"`,
    );
    return { name: "Deploy path", ok: true, message: deployPath };
  } catch {
    return {
      name: "Deploy path",
      ok: false,
      message: `${deployPath} is not writable`,
    };
  }
}

export async function checkPasswordlessSudo(
  target: SSHTarget,
): Promise<DoctorCheckResult> {
  try {
    await sshExec(target, "sudo -n true");
    return { name: "sudo", ok: true, message: "passwordless sudo available" };
  } catch {
    return {
      name: "sudo",
      ok: false,
      message:
        "passwordless sudo not available — required by `nodeploy setup` to install packages, and by `proxy` to write nginx config",
    };
  }
}

export async function runAllChecks(
  config: DeployConfig,
  target: SSHTarget,
): Promise<DoctorCheckResult[]> {
  const connection = await checkSSHConnection(target);
  if (!connection.ok) {
    return [connection];
  }

  const checks = [
    checkNode(target),
    checkNpm(target),
    checkPnpm(target),
    checkPM2(target),
    checkNginx(target),
    checkDiskSpace(target),
    checkMemory(target),
    checkDeployPathWritable(target, config.deployPath),
    checkPasswordlessSudo(target),
  ];

  if (config.runtime === "python") {
    checks.push(checkPython(target));
  }

  return [connection, ...(await Promise.all(checks))];
}
