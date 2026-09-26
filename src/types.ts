export type JSAppType =
  | "express"
  | "nestjs"
  | "nextjs"
  | "remix"
  | "cra"
  | "vite"
  | "generic";

/** Flask apps get a requirements.txt/pyproject.toml install step; "python" is
 * the pure-stdlib fallback (e.g. a plain http.server script) with nothing to install. */
export type PythonAppType = "flask" | "python";

export type AppType = JSAppType | PythonAppType;

export type Runtime = "node" | "python";

export type PackageManagerName = "npm" | "pnpm" | "pip";

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

/** HTTPS via a per-app Let's Encrypt certificate, issued with certbot's
 * webroot (HTTP-01) challenge — `proxy.host` must resolve publicly to the
 * server, with port 80 reachable from the internet. */
export interface SSLConfig {
  /** Let's Encrypt account email for expiry notices. Optional. */
  email?: string;
}

/** A front-door nginx box that the router forwards public 80/443 to, which
 * routes each app's hostname on to the server actually running it. */
export interface EdgeConfig {
  server: string;
  /** Defaults to the app's own `ssh` block. */
  ssh: SSHConfig;
  /** Address the edge uses to reach this app's server. Defaults to `server`. */
  upstream: string;
}

export interface ProxyConfig {
  host: string;
  ssl?: SSLConfig;
  edge?: EdgeConfig;
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
  runtime: Runtime;
  /** Entry script relative to deployPath, e.g. "server.py". Required for runtime: python. */
  entry?: string;
  port?: number;
  proxy?: ProxyConfig;
  startArgs?: string[];
  /** Overrides the auto-detected start script (e.g. "start:lan"). Node only. */
  startScript?: string;
}

/** An SSH connection target derived from a DeployConfig. */
export interface SSHTarget {
  host: string;
  user: string;
  port: number;
  keys?: string[];
}

/** A detected app running on the remote server, resolved from its remote package.json
 * (node) or requirements.txt/pyproject.toml/entry file (python). */
export interface RemoteApp {
  name: string;
  dir: string;
  type: AppType;
  runtime: Runtime;
  packageManager: PackageManagerName;
  installCmd: string[];
  buildCmd: string[] | null;
  startCmd: string[];
  startArgs: string[];
  /** Build output dir to serve directly via nginx, or null to run under PM2. */
  staticDir: string | null;
  /** Absolute path to the interpreter PM2 should run startCmd with (a venv's
   * python3). Only set for runtime: python. */
  interpreter?: string;
  /** Env vars exported before the PM2 start command, e.g. PORT for a Python
   * app that reads its bind port from the environment. */
  env?: Record<string, string>;
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
