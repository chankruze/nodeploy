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

/** Shape of a per-app `nodeploy.json` file. */
export interface AppConfig {
  name: string;
  port: number;
  env?: Record<string, string>;
}

export interface DetectedApp {
  name: string;
  dir: string;
  port?: number;
  type: AppType;
  packageManager: PackageManagerName;
  installCmd: string[];
  buildCmd: string[] | null;
  startCmd: string[];
  pkg: PackageJson;
  hasNodeployConfig: boolean;
}

/** Shape of the global `~/.nodeploy/config.json` file. */
export interface GlobalConfig {
  appsDir: string;
  defaults?: {
    packageManager?: PackageManagerName | "auto";
  };
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
