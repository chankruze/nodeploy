import { withNvm } from "./remoteEnv.js";
import { sshExec } from "./ssh.js";
import type { PM2ProcessInfo, PM2Status, RemoteApp, SSHTarget } from "../types.js";

export interface PM2Adapter {
  start(app: RemoteApp): Promise<void>;
  restart(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<PM2ProcessInfo[]>;
  logs(name: string, opts?: { lines?: number }): Promise<void>;
  save(): Promise<void>;
  isInstalled(): Promise<boolean>;
}

interface PM2RawProcess {
  name: string;
  pid: number;
  pm2_env: {
    status: string;
    pm_uptime: number;
    restart_time: number;
  };
  monit: {
    cpu: number;
    memory: number;
  };
}

const KNOWN_STATUSES: PM2Status[] = [
  "online",
  "stopped",
  "errored",
  "stopping",
  "launching",
];

function normalizeStatus(status: string): PM2Status {
  return KNOWN_STATUSES.includes(status as PM2Status)
    ? (status as PM2Status)
    : "unknown";
}

function toProcessInfo(raw: PM2RawProcess): PM2ProcessInfo {
  return {
    name: raw.name,
    pid: raw.pid,
    status: normalizeStatus(raw.pm2_env.status),
    cpu: raw.monit.cpu,
    memoryBytes: raw.monit.memory,
    uptimeMs:
      raw.pm2_env.status === "online" && raw.pm2_env.pm_uptime
        ? Date.now() - raw.pm2_env.pm_uptime
        : null,
    restarts: raw.pm2_env.restart_time,
  };
}

export class SSHPM2Adapter implements PM2Adapter {
  constructor(private readonly target: SSHTarget) {}

  async start(app: RemoteApp): Promise<void> {
    const existing = await this.list();
    if (existing.some((p) => p.name === app.name)) {
      await this.restart(app.name);
      await this.save();
      return;
    }

    const scriptName = app.startCmd[app.startCmd.length - 1];
    await sshExec(
      this.target,
      withNvm(
        `cd "${app.dir}" && pm2 start npm --name "${app.name}" -- run ${scriptName}`,
      ),
    );
    await this.save();
  }

  async restart(name: string): Promise<void> {
    await sshExec(this.target, withNvm(`pm2 restart "${name}"`));
  }

  async stop(name: string): Promise<void> {
    await sshExec(this.target, withNvm(`pm2 stop "${name}"`));
  }

  async delete(name: string): Promise<void> {
    await sshExec(this.target, withNvm(`pm2 delete "${name}"`));
  }

  async list(): Promise<PM2ProcessInfo[]> {
    const { stdout } = await sshExec(this.target, withNvm("pm2 jlist"));
    const raw: PM2RawProcess[] = JSON.parse(stdout);
    return raw.map(toProcessInfo);
  }

  async logs(name: string, opts: { lines?: number } = {}): Promise<void> {
    const lines = opts.lines !== undefined ? ` --lines ${opts.lines}` : "";
    await sshExec(this.target, withNvm(`pm2 logs "${name}"${lines}`), {
      stdio: "inherit",
    });
  }

  async isInstalled(): Promise<boolean> {
    try {
      await sshExec(this.target, withNvm("pm2 --version"));
      return true;
    } catch {
      return false;
    }
  }

  async save(): Promise<void> {
    await sshExec(this.target, withNvm("pm2 save"));
  }
}

export function createPM2Adapter(target: SSHTarget): PM2Adapter {
  return new SSHPM2Adapter(target);
}
