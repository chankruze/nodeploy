import fs from "node:fs";
import os from "node:os";
import { execa } from "execa";
import type { DoctorCheckResult, GlobalConfig } from "../types.js";

export async function checkNode(): Promise<DoctorCheckResult> {
  return {
    name: "Node",
    ok: true,
    message: process.version,
  };
}

export async function checkPackageManager(
  name: "npm" | "pnpm",
): Promise<DoctorCheckResult> {
  try {
    const { stdout } = await execa(name, ["--version"]);
    return { name, ok: true, message: stdout.trim() };
  } catch {
    return {
      name,
      ok: false,
      message: `${name} not found on PATH`,
      optional: name === "pnpm",
    };
  }
}

export async function checkPM2(): Promise<DoctorCheckResult> {
  try {
    const { stdout } = await execa("pm2", ["--version"]);
    return { name: "PM2", ok: true, message: stdout.trim() };
  } catch {
    return {
      name: "PM2",
      ok: false,
      message: "pm2 not found on PATH — install with `npm i -g pm2`",
    };
  }
}

export async function checkNginx(): Promise<DoctorCheckResult> {
  try {
    const { stdout } = await execa("nginx", ["-v"]);
    return { name: "nginx", ok: true, message: stdout.trim(), optional: true };
  } catch {
    return {
      name: "nginx",
      ok: false,
      message: "nginx not found on PATH (optional for PM2-only setups)",
      optional: true,
    };
  }
}

export async function checkDiskSpace(): Promise<DoctorCheckResult> {
  try {
    const { stdout } = await execa("df", ["-h", os.homedir()]);
    const lastLine = stdout.trim().split("\n").pop() ?? "";
    return { name: "Disk", ok: true, message: lastLine.trim() };
  } catch (error) {
    return {
      name: "Disk",
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      optional: true,
    };
  }
}

export async function checkMemory(): Promise<DoctorCheckResult> {
  const freeGb = os.freemem() / 1024 ** 3;
  const totalGb = os.totalmem() / 1024 ** 3;
  return {
    name: "RAM",
    ok: true,
    message: `${freeGb.toFixed(1)}GB free / ${totalGb.toFixed(1)}GB total`,
  };
}

export async function checkAppsDirWritable(
  appsDir: string,
): Promise<DoctorCheckResult> {
  try {
    if (!fs.existsSync(appsDir)) {
      return {
        name: "Apps directory",
        ok: false,
        message: `${appsDir} does not exist — run \`nodeploy init\``,
      };
    }
    fs.accessSync(appsDir, fs.constants.W_OK);
    return { name: "Apps directory", ok: true, message: appsDir };
  } catch {
    return {
      name: "Apps directory",
      ok: false,
      message: `${appsDir} is not writable`,
    };
  }
}

export async function runAllChecks(
  config: GlobalConfig,
): Promise<DoctorCheckResult[]> {
  return Promise.all([
    checkNode(),
    checkPackageManager("npm"),
    checkPackageManager("pnpm"),
    checkPM2(),
    checkNginx(),
    checkDiskSpace(),
    checkMemory(),
    checkAppsDirWritable(config.appsDir),
  ]);
}
