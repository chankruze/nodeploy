export type AppType =
  | "express"
  | "nestjs"
  | "nextjs"
  | "cra"
  | "vite"
  | "generic";

export type PackageManagerName = "npm" | "pnpm";

export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface SSHConfig {
  user: string;
  keys?: string[];
  port?: number;
}

export interface ProxyConfig {
  host: string;
}

/** Shape of a per-app `nodeploy.yml` file. */
export interface DeployConfig {
  service: string;
  repo: string;
  branch: string;
  server: string;
  ssh: SSHConfig;
  deployPath: string;
  nodeVersion: string;
  port?: number;
  proxy?: ProxyConfig;
}

/** An SSH connection target derived from a DeployConfig. */
export interface SSHTarget {
  host: string;
  user: string;
  port: number;
  keys?: string[];
}

/** A detected app running on the remote server, resolved from its remote package.json. */
export interface RemoteApp {
  name: string;
  dir: string;
  type: AppType;
  packageManager: PackageManagerName;
  installCmd: string[];
  buildCmd: string[] | null;
  startCmd: string[];
}

export type PM2Status =
  | "online"
  | "stopped"
  | "errored"
  | "stopping"
  | "launching"
  | "unknown";

export interface PM2ProcessInfo {
  name: string;
  pid: number;
  status: PM2Status;
  cpu: number;
  memoryBytes: number;
  uptimeMs: number | null;
  restarts: number;
}

export interface DoctorCheckResult {
  name: string;
  ok: boolean;
  message: string;
  optional?: boolean;
}
