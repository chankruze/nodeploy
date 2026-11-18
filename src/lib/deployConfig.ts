import fs from "node:fs";
import path from "node:path";
import { isMap, parse, parseDocument } from "yaml";
import {
  DEFAULT_BACKUP_KEEP,
  DEFAULT_BACKUP_SCHEDULE,
  isValidSchedule,
} from "./backup.js";
import { emailAddress } from "./backupMail.js";
import { isValidMaxSize } from "./logRotation.js";
import {
  DEFAULT_BRANCH,
  DEFAULT_NODE_VERSION,
  DEFAULT_RUNTIME,
  DEFAULT_SSH_PORT,
} from "../constants.js";
import type {
  BackupConfig,
  BackupCopyConfig,
  BackupDownloadConfig,
  BackupEmailConfig,
  DeployConfig,
  EdgeConfig,
  LogRotationConfig,
  Runtime,
  SSHConfig,
  SSHTarget,
  SSLConfig,
} from "../types.js";

// `~` only expands via shell tilde-expansion, which doesn't happen when a path
// is interpolated inside a double-quoted string (as every remote command here
// does) — normalize to `$HOME`, which does expand in that context.
function normalizeHomePath(deployPath: string): string {
  if (deployPath === "~") return "$HOME";
  if (deployPath.startsWith("~/")) return `$HOME/${deployPath.slice(2)}`;
  return deployPath;
}

function validateSSHConfig(raw: unknown, key: string): SSHConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`nodeploy.yml: "${key}" must be an object`);
  }

  const sshRaw = raw as Record<string, unknown>;
  if (typeof sshRaw.user !== "string" || sshRaw.user.length === 0) {
    throw new Error(`nodeploy.yml: "${key}.user" must be a non-empty string`);
  }

  if (sshRaw.keys !== undefined) {
    if (
      !Array.isArray(sshRaw.keys) ||
      !sshRaw.keys.every((k) => typeof k === "string")
    ) {
      throw new Error(`nodeploy.yml: "${key}.keys" must be an array of strings`);
    }
  }

  if (sshRaw.port !== undefined && typeof sshRaw.port !== "number") {
    throw new Error(`nodeploy.yml: "${key}.port" must be a number`);
  }

  return {
    user: sshRaw.user,
    keys: sshRaw.keys as string[] | undefined,
    port: (sshRaw.port as number | undefined) ?? DEFAULT_SSH_PORT,
  };
}

function validateEdgeConfig(
  raw: unknown,
  server: string,
  ssh: SSHConfig,
): EdgeConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("nodeploy.yml: \"proxy.edge\" must be an object");
  }

  const edgeRaw = raw as Record<string, unknown>;
  if (typeof edgeRaw.server !== "string" || edgeRaw.server.length === 0) {
    throw new Error(
      "nodeploy.yml: \"proxy.edge.server\" must be a non-empty string",
    );
  }

  if (
    edgeRaw.upstream !== undefined &&
    (typeof edgeRaw.upstream !== "string" || edgeRaw.upstream.length === 0)
  ) {
    throw new Error(
      "nodeploy.yml: \"proxy.edge.upstream\" must be a non-empty string",
    );
  }

  // The edge's port-80 forward would claim proxy.host on the same nginx as
  // the app's own site. Apps on the edge need no `edge` at all: deploy
  // detects the edge's SNI router and routes their HTTPS locally.
  if (edgeRaw.server === server) {
    throw new Error(
      "nodeploy.yml: \"proxy.edge.server\" is the same as \"server\" — apps running on the edge box itself don't need `edge` (nodeploy detects the edge and routes their HTTPS locally); remove it",
    );
  }

  return {
    server: edgeRaw.server,
    ssh:
      edgeRaw.ssh === undefined
        ? ssh
        : validateSSHConfig(edgeRaw.ssh, "proxy.edge.ssh"),
    upstream: (edgeRaw.upstream as string | undefined) ?? server,
  };
}

/** `log_rotation: true`/`false` is shorthand for `{ enabled: ... }`. Only
 * the keys actually set are returned, so the server-side defaults logic can
 * tell an explicit setting from a default. */
export function validateLogRotation(raw: unknown): Partial<LogRotationConfig> {
  if (typeof raw === "boolean") return { enabled: raw };
  if (typeof raw !== "object" || raw === null) {
    throw new Error(
      "nodeploy.yml: \"log_rotation\" must be true, false, or an object (e.g. log_rotation: { max_size: 50M, retain: 7 })",
    );
  }

  const r = raw as Record<string, unknown>;
  const known = ["enabled", "max_size", "retain", "compress", "interval"];
  for (const key of Object.keys(r)) {
    if (!known.includes(key)) {
      throw new Error(
        `nodeploy.yml: unknown key "log_rotation.${key}" (expected one of: ${known.join(", ")})`,
      );
    }
  }

  const result: Partial<LogRotationConfig> = {};
  for (const key of ["enabled", "compress"] as const) {
    if (r[key] === undefined) continue;
    if (typeof r[key] !== "boolean") {
      throw new Error(`nodeploy.yml: "log_rotation.${key}" must be true or false`);
    }
    result[key] = r[key];
  }

  if (r.max_size !== undefined) {
    // YAML reads a bare `max_size: 1048576` as a number of bytes.
    const size = typeof r.max_size === "number" ? String(r.max_size) : r.max_size;
    if (typeof size !== "string" || !isValidMaxSize(size)) {
      throw new Error(
        "nodeploy.yml: \"log_rotation.max_size\" must be a size like 50M, 500K, or 1G (at least 1K)",
      );
    }
    result.maxSize = size.toUpperCase();
  }

  for (const [key, field] of [
    ["retain", "retain"],
    ["interval", "interval"],
  ] as const) {
    const value = r[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(
        `nodeploy.yml: "log_rotation.${key}" must be a whole number of at least 1${key === "interval" ? " (seconds)" : ""}`,
      );
    }
    result[field] = value;
  }

  return result;
}

const COPY_PATH = /^(~\/)?[A-Za-z0-9._/-]+$/;

function validateBackupCopy(raw: unknown, ssh: SSHConfig, keep: number): BackupCopyConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("nodeploy.yml: \"backup.copy_to\" must be an object (e.g. copy_to: { server: 192.168.0.12 })");
  }
  const r = raw as Record<string, unknown>;
  const known = ["server", "ssh", "path", "keep"];
  for (const key of Object.keys(r)) {
    if (!known.includes(key)) {
      throw new Error(`nodeploy.yml: unknown key "backup.copy_to.${key}" (expected one of: ${known.join(", ")})`);
    }
  }
  if (typeof r.server !== "string" || r.server.length === 0) {
    throw new Error("nodeploy.yml: \"backup.copy_to.server\" must be a non-empty string");
  }
  let path = "nodeploy-backups";
  if (r.path !== undefined) {
    if (typeof r.path !== "string" || !COPY_PATH.test(r.path) || r.path.split("/").includes("..")) {
      throw new Error("nodeploy.yml: \"backup.copy_to.path\" must be a directory like nodeploy-backups or /srv/backups (letters, digits, . _ - / only)");
    }
    path = r.path.replace(/^~\//, "").replace(/\/+$/, "");
  }
  let copyKeep = keep;
  if (r.keep !== undefined) {
    if (typeof r.keep !== "number" || !Number.isInteger(r.keep) || r.keep < 1) {
      throw new Error("nodeploy.yml: \"backup.copy_to.keep\" must be a whole number of at least 1");
    }
    copyKeep = r.keep;
  }
  return {
    server: r.server,
    ssh: r.ssh === undefined ? ssh : validateSSHConfig(r.ssh, "backup.copy_to.ssh"),
    path,
    keep: copyKeep,
  };
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const HOSTNAME = /^[A-Za-z0-9.-]+$/;

function validateBackupEmail(raw: unknown): BackupEmailConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("nodeploy.yml: \"backup.email\" must be an object (e.g. email: { to: [you@example.com], smtp: { host: smtp.example.com, user: backups@example.com } })");
  }
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!["to", "from", "smtp"].includes(key)) {
      throw new Error(`nodeploy.yml: unknown key "backup.email.${key}" (expected one of: to, from, smtp)`);
    }
  }
  const to = typeof r.to === "string" ? [r.to] : r.to;
  if (!Array.isArray(to) || to.length === 0 || !to.every((a) => typeof a === "string" && EMAIL.test(a.trim()))) {
    throw new Error("nodeploy.yml: \"backup.email.to\" must be an email address or a list of them");
  }
  const smtpRaw = r.smtp as Record<string, unknown> | undefined;
  if (typeof smtpRaw !== "object" || smtpRaw === null) {
    throw new Error("nodeploy.yml: \"backup.email.smtp\" must be an object with host and user (the password is never stored here — see `nodeploy backup setup`)");
  }
  for (const key of Object.keys(smtpRaw)) {
    if (key === "password" || key === "pass") {
      throw new Error("nodeploy.yml: don't put the SMTP password in nodeploy.yml — run `nodeploy backup setup` with NODEPLOY_SMTP_PASSWORD set instead; it's stored on the server, readable only by the SSH user");
    }
    if (!["host", "port", "user"].includes(key)) {
      throw new Error(`nodeploy.yml: unknown key "backup.email.smtp.${key}" (expected one of: host, port, user)`);
    }
  }
  if (typeof smtpRaw.host !== "string" || !HOSTNAME.test(smtpRaw.host)) {
    throw new Error("nodeploy.yml: \"backup.email.smtp.host\" must be a hostname like smtp.gmail.com");
  }
  if (typeof smtpRaw.user !== "string" || smtpRaw.user.trim().length === 0 || /\s/.test(smtpRaw.user)) {
    throw new Error("nodeploy.yml: \"backup.email.smtp.user\" must be the SMTP login, usually the sending address");
  }
  let port = 587;
  if (smtpRaw.port !== undefined) {
    if (typeof smtpRaw.port !== "number" || !Number.isInteger(smtpRaw.port) || smtpRaw.port < 1 || smtpRaw.port > 65535) {
      throw new Error("nodeploy.yml: \"backup.email.smtp.port\" must be a port number (587 for STARTTLS, 465 for TLS)");
    }
    port = smtpRaw.port;
  }
  let from = smtpRaw.user;
  if (r.from !== undefined) {
    if (typeof r.from !== "string" || !EMAIL.test(emailAddress(r.from)) || /[\r\n]/.test(r.from)) {
      throw new Error("nodeploy.yml: \"backup.email.from\" must be an address or \"Name <address>\"");
    }
    from = r.from.trim();
  }
  return { to: (to as string[]).map((a) => a.trim()), from, smtp: { host: smtpRaw.host, port, user: smtpRaw.user.trim() } };
}

function validateBackupDownload(raw: unknown, hasPublicSite: boolean): BackupDownloadConfig {
  const r = (raw === true ? {} : raw) as Record<string, unknown>;
  if (typeof r !== "object" || r === null || Array.isArray(r)) {
    throw new Error("nodeploy.yml: \"backup.download\" must be true or an object (e.g. download: { lan_port: 8799, expires: 7 })");
  }
  for (const key of Object.keys(r)) {
    if (!["lan_port", "public", "expires"].includes(key)) {
      throw new Error(`nodeploy.yml: unknown key "backup.download.${key}" (expected one of: lan_port, public, expires)`);
    }
  }
  let lanPort: number | null = 8799;
  if (r.lan_port === false) lanPort = null;
  else if (r.lan_port !== undefined) {
    if (typeof r.lan_port !== "number" || !Number.isInteger(r.lan_port) || r.lan_port < 1024 || r.lan_port > 65535) {
      throw new Error("nodeploy.yml: \"backup.download.lan_port\" must be a free port from 1024 to 65535, or false");
    }
    lanPort = r.lan_port;
  }
  let isPublic = hasPublicSite;
  if (r.public !== undefined) {
    if (typeof r.public !== "boolean") throw new Error("nodeploy.yml: \"backup.download.public\" must be true or false");
    if (r.public && !hasPublicSite) {
      throw new Error("nodeploy.yml: \"backup.download.public\" needs the app's own HTTPS site (proxy.host with proxy.ssl) to serve links from");
    }
    isPublic = r.public;
  }
  let expiresDays = 7;
  if (r.expires !== undefined) {
    if (typeof r.expires !== "number" || !Number.isInteger(r.expires) || r.expires < 1 || r.expires > 30) {
      throw new Error("nodeploy.yml: \"backup.download.expires\" must be a number of days from 1 to 30");
    }
    expiresDays = r.expires;
  }
  if (lanPort === null && !isPublic) {
    throw new Error("nodeploy.yml: \"backup.download\" has no link left to make — keep lan_port or public");
  }
  return { lanPort, public: isPublic, expiresDays };
}

export function validateBackup(raw: unknown, ssh: SSHConfig, hasPublicSite = false): BackupConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      "nodeploy.yml: \"backup\" must be an object (e.g. backup: { paths: [data/app.db] })",
    );
  }
  const r = raw as Record<string, unknown>;
  const known = ["paths", "schedule", "keep", "copy_to", "email", "download"];
  for (const key of Object.keys(r)) {
    if (!known.includes(key)) {
      throw new Error(
        `nodeploy.yml: unknown key "backup.${key}" (expected one of: ${known.join(", ")})`,
      );
    }
  }

  if (
    !Array.isArray(r.paths) ||
    r.paths.length === 0 ||
    !r.paths.every((p) => typeof p === "string" && p.trim().length > 0)
  ) {
    throw new Error(
      "nodeploy.yml: \"backup.paths\" must be a non-empty list of files or directories, relative to deploy_path (e.g. [data/app.db, uploads])",
    );
  }
  const paths = (r.paths as string[]).map((p) => p.trim().replace(/\/+$/, ""));
  for (const p of paths) {
    if (p.startsWith("/") || p.startsWith("~") || p.startsWith("$") || p.split("/").includes("..") || p === ".") {
      throw new Error(
        `nodeploy.yml: "backup.paths" entry "${p}" must be a path inside deploy_path, e.g. data/app.db (no absolute paths, "~", or "..")`,
      );
    }
  }

  let schedule = DEFAULT_BACKUP_SCHEDULE;
  if (r.schedule !== undefined) {
    if (typeof r.schedule !== "string" || !isValidSchedule(r.schedule)) {
      throw new Error(
        "nodeploy.yml: \"backup.schedule\" must be daily, hourly, off, or a cron expression like \"30 1 * * *\"",
      );
    }
    schedule = r.schedule.trim();
  }

  let keep = DEFAULT_BACKUP_KEEP;
  if (r.keep !== undefined) {
    if (typeof r.keep !== "number" || !Number.isInteger(r.keep) || r.keep < 1) {
      throw new Error("nodeploy.yml: \"backup.keep\" must be a whole number of at least 1");
    }
    keep = r.keep;
  }

  const backup: BackupConfig = { paths: [...new Set(paths)], schedule, keep };
  if (r.copy_to !== undefined) backup.copyTo = validateBackupCopy(r.copy_to, ssh, keep);
  if (r.email !== undefined) backup.email = validateBackupEmail(r.email);
  if (r.download !== undefined && r.download !== false) {
    backup.download = validateBackupDownload(r.download, hasPublicSite);
  }
  return backup;
}

// Fields that only make sense when nodeploy checks out and runs the app.
const NOT_FOR_EXTERNAL = [
  "repo",
  "branch",
  "deploy_path",
  "node_version",
  "entry",
  "start_args",
  "start_script",
  "log_rotation",
  "backup",
] as const;

export function validateDeployConfig(raw: unknown): DeployConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("nodeploy.yml must be a YAML object");
  }

  const candidate = raw as Record<string, unknown>;

  if (typeof candidate.service !== "string" || candidate.service.length === 0) {
    throw new Error("nodeploy.yml: \"service\" must be a non-empty string");
  }

  const external = candidate.runtime === "external";
  if (external) {
    for (const key of NOT_FOR_EXTERNAL) {
      if (candidate[key] !== undefined) {
        throw new Error(
          `nodeploy.yml: "${key}" doesn't apply to runtime: external — the app is deployed by another tool, nodeploy only fronts it with nginx; remove it`,
        );
      }
    }
  } else if (
    typeof candidate.repo !== "string" ||
    candidate.repo.length === 0
  ) {
    throw new Error("nodeploy.yml: \"repo\" must be a non-empty string");
  }

  if (typeof candidate.server !== "string" || candidate.server.length === 0) {
    throw new Error("nodeploy.yml: \"server\" must be a non-empty string");
  }

  const ssh = validateSSHConfig(candidate.ssh, "ssh");

  if (candidate.branch !== undefined && typeof candidate.branch !== "string") {
    throw new Error("nodeploy.yml: \"branch\" must be a string");
  }

  if (
    candidate.deploy_path !== undefined &&
    typeof candidate.deploy_path !== "string"
  ) {
    throw new Error("nodeploy.yml: \"deploy_path\" must be a string");
  }

  if (candidate.port !== undefined && typeof candidate.port !== "number") {
    throw new Error("nodeploy.yml: \"port\" must be a number");
  }

  if (candidate.start_args !== undefined) {
    if (
      !Array.isArray(candidate.start_args) ||
      !candidate.start_args.every((a) => typeof a === "string")
    ) {
      throw new Error(
        "nodeploy.yml: \"start_args\" must be an array of strings",
      );
    }
  }

  if (
    candidate.start_script !== undefined &&
    (typeof candidate.start_script !== "string" ||
      candidate.start_script.length === 0)
  ) {
    throw new Error(
      "nodeploy.yml: \"start_script\" must be a non-empty string",
    );
  }

  if (
    candidate.node_version !== undefined &&
    typeof candidate.node_version !== "string"
  ) {
    throw new Error("nodeploy.yml: \"node_version\" must be a string");
  }

  let runtime: Runtime = DEFAULT_RUNTIME;
  if (candidate.runtime !== undefined) {
    if (
      candidate.runtime !== "node" &&
      candidate.runtime !== "python" &&
      candidate.runtime !== "external"
    ) {
      throw new Error(
        "nodeploy.yml: \"runtime\" must be \"node\", \"python\", or \"external\"",
      );
    }
    runtime = candidate.runtime;
  }

  if (candidate.entry !== undefined && typeof candidate.entry !== "string") {
    throw new Error("nodeploy.yml: \"entry\" must be a string");
  }

  if (runtime === "python" && typeof candidate.entry !== "string") {
    throw new Error(
      "nodeploy.yml: \"entry\" is required when \"runtime\" is \"python\" (e.g. entry: server.py)",
    );
  }

  let proxy: DeployConfig["proxy"];
  if (candidate.proxy !== undefined) {
    if (typeof candidate.proxy !== "object" || candidate.proxy === null) {
      throw new Error("nodeploy.yml: \"proxy\" must be an object");
    }
    const proxyRaw = candidate.proxy as Record<string, unknown>;
    if (typeof proxyRaw.host !== "string" || proxyRaw.host.length === 0) {
      throw new Error("nodeploy.yml: \"proxy.host\" must be a non-empty string");
    }
    proxy = { host: proxyRaw.host };

    // `ssl: true` is shorthand for `ssl: {}` (no registration email).
    if (proxyRaw.ssl === true) {
      proxy.ssl = {};
    } else if (typeof proxyRaw.ssl === "object" && proxyRaw.ssl !== null) {
      const sslRaw = proxyRaw.ssl as Record<string, unknown>;
      if (
        sslRaw.email !== undefined &&
        (typeof sslRaw.email !== "string" || sslRaw.email.length === 0)
      ) {
        throw new Error(
          "nodeploy.yml: \"proxy.ssl.email\" must be a non-empty string",
        );
      }
      if (sslRaw.dns !== undefined && sslRaw.dns !== "cloudflare") {
        throw new Error(
          "nodeploy.yml: \"proxy.ssl.dns\" must be \"cloudflare\" (the only DNS provider supported so far)",
        );
      }
      proxy.ssl = {
        email: sslRaw.email as string | undefined,
        dns: sslRaw.dns as SSLConfig["dns"],
      };
    } else if (proxyRaw.ssl !== undefined && proxyRaw.ssl !== false) {
      throw new Error(
        "nodeploy.yml: \"proxy.ssl\" must be true, false, or an object (e.g. ssl: { email: you@example.com })",
      );
    }

    if (proxyRaw.edge !== undefined) {
      proxy.edge = validateEdgeConfig(proxyRaw.edge, candidate.server, ssh);
    }
  }

  // Without both there's nothing for nodeploy to do for an external app.
  if (external && (!proxy || typeof candidate.port !== "number")) {
    throw new Error(
      "nodeploy.yml: runtime: external needs \"port\" (where the app listens on the server, e.g. kamal-proxy's http_port) and \"proxy.host\"",
    );
  }

  const config: DeployConfig = {
    service: candidate.service,
    repo: (candidate.repo as string | undefined) ?? "",
    branch: candidate.branch ?? DEFAULT_BRANCH,
    server: candidate.server,
    ssh,
    deployPath: normalizeHomePath(
      (candidate.deploy_path as string | undefined) ??
        `$HOME/apps/${candidate.service}`,
    ),
    nodeVersion:
      (candidate.node_version as string | undefined) ?? DEFAULT_NODE_VERSION,
    runtime,
    entry: candidate.entry as string | undefined,
    port: candidate.port as number | undefined,
    proxy,
    startArgs: candidate.start_args as string[] | undefined,
    startScript: candidate.start_script as string | undefined,
  };

  if (candidate.log_rotation !== undefined) {
    config.logRotation = validateLogRotation(candidate.log_rotation);
  }
  if (candidate.backup !== undefined) {
    config.backup = validateBackup(candidate.backup, ssh, Boolean(proxy?.ssl));
  }

  return config;
}

export function loadDeployConfig(cwd: string, filename: string): DeployConfig {
  const configPath = path.join(cwd, filename);

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No ${filename} found in ${cwd} — run \`nodeploy init\` first`,
    );
  }

  const raw = parse(fs.readFileSync(configPath, "utf-8"));
  return validateDeployConfig(raw);
}

function sshTargetFor(host: string, ssh: SSHConfig): SSHTarget {
  return {
    host,
    user: ssh.user,
    port: ssh.port ?? DEFAULT_SSH_PORT,
    keys: ssh.keys,
  };
}

export function toSSHTarget(config: DeployConfig): SSHTarget {
  return sshTargetFor(config.server, config.ssh);
}

export function toEdgeSSHTarget(edge: EdgeConfig): SSHTarget {
  return sshTargetFor(edge.server, edge.ssh);
}

const LOG_ROTATION_KEYS: Record<keyof LogRotationConfig, string> = {
  enabled: "enabled",
  maxSize: "max_size",
  retain: "retain",
  compress: "compress",
  interval: "interval",
};

/** Sets `log_rotation` keys in nodeploy.yml's source, keeping its comments
 * and layout. Expands the `log_rotation: true/false` shorthand to a map. */
export function setLogRotationInYaml(
  source: string,
  changes: Partial<LogRotationConfig>,
): string {
  const doc = parseDocument(source);
  const current = doc.get("log_rotation", true);
  if (current !== undefined && current !== null && !isMap(current)) {
    const enabled = doc.get("log_rotation");
    doc.set("log_rotation", doc.createNode({ enabled: enabled !== false }));
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    doc.setIn(
      ["log_rotation", LOG_ROTATION_KEYS[key as keyof LogRotationConfig]],
      value,
    );
  }
  return doc.toString();
}

/** Applies `changes` to the nodeploy.yml in `cwd`, refusing to write a file
 * that wouldn't load. Returns the updated config. */
export function updateLogRotationConfig(
  cwd: string,
  filename: string,
  changes: Partial<LogRotationConfig>,
): DeployConfig {
  const configPath = path.join(cwd, filename);
  const updated = setLogRotationInYaml(
    fs.readFileSync(configPath, "utf-8"),
    changes,
  );
  const config = validateDeployConfig(parse(updated));
  fs.writeFileSync(configPath, updated);
  return config;
}
