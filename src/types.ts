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

/** "external" apps are run by another tool (e.g. Kamal, docker compose) on a
 * local port; nodeploy only manages their nginx site, certificate, and edge
 * routes. */
export type Runtime = "node" | "python" | "external";

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

/** HTTPS via a per-app Let's Encrypt certificate. By default it's issued
 * with certbot's webroot (HTTP-01) challenge — `proxy.host` must resolve
 * publicly to the server, with port 80 reachable from the internet. With
 * `dns`, it's issued via a DNS-01 challenge instead, which needs neither
 * (for LAN-only servers). */
export interface SSLConfig {
  /** Let's Encrypt account email for expiry notices. Optional. */
  email?: string;
  /** DNS provider for a DNS-01 challenge, instead of HTTP-01. */
  dns?: "cloudflare";
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

/** PM2 log rotation, applied server-wide to the SSH user's PM2 daemon (every
 * app it runs, plus pm2.log) via the pm2-logrotate module. */
export interface LogRotationConfig {
  /** false: nodeploy doesn't install or configure rotation on this server. */
  enabled: boolean;
  /** Rotate once a log reaches this size: bytes, or a number with a K/M/G
   * suffix, e.g. "50M" (pm2-logrotate's own format). */
  maxSize: string;
  /** Rotated archives kept per log file; older ones are deleted. */
  retain: number;
  /** gzip rotated archives. */
  compress: boolean;
  /** Seconds between size checks. */
  interval: number;
}

/** Backups of an app's data, taken on the server by a script nodeploy
 * installs there: on a schedule, on demand, and before each deploy. */
export interface BackupConfig {
  /** Files or directories to back up, relative to deploy_path. */
  paths: string[];
  /** "daily" (02:xx server time), "hourly", "off", or a 5-field cron
   * expression. */
  schedule: string;
  /** Backups to keep; older ones are deleted. */
  keep: number;
}

/** Shape of a per-app `nodeploy.yml` file. */
export interface DeployConfig {
  service: string;
  /** Empty for runtime: external, which isn't deployed from a repo. */
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
  /** Only the settings set in nodeploy.yml's `log_rotation` — the rest fall
   * back to DEFAULT_LOG_ROTATION (see resolveLogRotation). */
  logRotation?: Partial<LogRotationConfig>;
  backup?: BackupConfig;
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
