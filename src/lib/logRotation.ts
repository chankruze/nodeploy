import { DEFAULT_LOG_ROTATION } from "../constants.js";
import { formatBytes } from "./format.js";
import { withNvm } from "./remoteEnv.js";
import { sshExec } from "./ssh.js";
import type { LogRotationConfig, SSHTarget } from "../types.js";

// Log rotation is a property of a PM2 daemon, not of one app: every app the
// SSH user's daemon runs (plus pm2.log) shares it. It's done by the
// pm2-logrotate module, which runs *inside* that daemon — so it rotates with
// the daemon owner's permissions and home, comes back with the daemon after a
// reboot (PM2 relaunches installed modules on start), and needs no cron,
// systemd unit, or sudo. Rotation is copy-then-truncate, which is safe because
// PM2 opens log files in append mode: after the truncate, writes land at the
// new end of the file, never past a hole.

export const LOGROTATE_MODULE = "pm2-logrotate";

/** Pinned so every server runs the same rotation code. 3.0.1 is also the
 * first release that honours `compress`/`rotateModule` at all and stops
 * overlapping rotations of one big file from filling the disk — older
 * installs are upgraded. */
export const LOGROTATE_VERSION = "3.0.1";

/** pm2-logrotate's default archive timestamp. `nodeploy logs rotate` names
 * its archives the same way, so the module's retention prunes them too. */
export const ARCHIVE_DATE_FORMAT = "YYYY-MM-DD_HH-mm-ss";

/** The SSH user's PM2 home, as a remote shell expression. */
export const REMOTE_PM2_HOME = '"${PM2_HOME:-$HOME/.pm2}"';

/** pm2-logrotate's own defaults, for reading a config it filled in itself. */
const MODULE_DEFAULTS = { maxSize: "10M", retain: 30, interval: 30 };

/** A single-quoted shell word, safe for any path. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const SIZE_PATTERN = /^(\d+)([KMG])?$/i;
const SIZE_UNITS: Record<string, number> = {
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
};

/** Bytes for a pm2-logrotate size ("50M", "1G", "1048576"), or null. */
export function parseMaxSize(size: string): number | null {
  const match = SIZE_PATTERN.exec(size.trim());
  if (!match) return null;
  const unit = match[2] ? SIZE_UNITS[match[2].toUpperCase()] : 1;
  return Number(match[1]) * unit;
}

/** pm2-logrotate only recognises upper-case suffixes (a lower-case "50m" is
 * read as 50 bytes), so callers normalise with toUpperCase() after this. */
export function isValidMaxSize(size: string): boolean {
  const bytes = parseMaxSize(size);
  return bytes !== null && bytes >= 1024;
}

export function resolveLogRotation(
  explicit: Partial<LogRotationConfig> = {},
): LogRotationConfig {
  return { ...DEFAULT_LOG_ROTATION, ...explicit };
}

// ─── Server state ──────────────────────────────────────────────────────────

export interface PM2LogProcess {
  name: string;
  status: string;
  isModule: boolean;
  /** Absolute out/err/combined log paths, minus /dev/null. */
  logPaths: string[];
}

export interface PM2Daemon {
  user: string;
  pm2Home: string;
}

export interface LogRotationState {
  pm2Home: string;
  /** Registered with PM2 (module_conf.json), so it's relaunched on boot. */
  installed: boolean;
  /** Version of the installed module package, if it's on disk. */
  version: string | null;
  /** Status of the module's PM2 process, or null if PM2 isn't running it. */
  moduleStatus: string | null;
  /** module_conf.json's raw "pm2-logrotate" settings. */
  settings: Record<string, unknown>;
  /** Every PM2 daemon on the server, whoever owns it. */
  daemons: PM2Daemon[];
  processes: PM2LogProcess[];
}

const SECTION = "__NODEPLOY_SECTION__";

/** One round trip for everything the log commands need to know. Each
 * marker starts with a newline of its own: the files cat'ed here (PM2's
 * module_conf.json, package.json) often don't end in one, and a marker glued
 * to the end of the previous line wouldn't be recognised. */
export function probeScript(): string {
  const home = REMOTE_PM2_HOME;
  const marker = (name: string) => `printf '\\n%s\\n' "${SECTION} ${name}"`;
  return [
    `H=${home}`,
    `${marker("home")}; echo "$H"`,
    `${marker("conf")}; cat "$H/module_conf.json" 2>/dev/null`,
    `${marker("package")}; cat "$H/modules/${LOGROTATE_MODULE}/node_modules/${LOGROTATE_MODULE}/package.json" 2>/dev/null`,
    // user:32 keeps long user names from being shown as a uid.
    `${marker("daemons")}; (ps -eo user:32=,args= 2>/dev/null || ps -eo user=,args=) | grep 'God Daemon' | grep -v grep`,
    `${marker("jlist")}; pm2 jlist`,
    "",
  ].join("\n");
}

function splitSections(stdout: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current: string | null = null;
  const lines: string[] = [];
  const flush = () => {
    if (current) sections[current] = lines.join("\n").trim();
    lines.length = 0;
  };
  for (const line of stdout.split("\n")) {
    if (line.startsWith(`${SECTION} `)) {
      flush();
      current = line.slice(SECTION.length + 1).trim();
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

function parseJSON(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface RawJlistProcess {
  name?: string;
  pm2_env?: {
    status?: string;
    pmx_module?: boolean;
    axm_options?: { isModule?: boolean };
    pm_out_log_path?: string;
    pm_err_log_path?: string;
    pm_log_path?: string;
  };
}

function isRealLogPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.includes("/dev/null") &&
    !path.includes("NULL")
  );
}

export function parseProbe(stdout: string): LogRotationState {
  const sections = splitSections(stdout);

  // PM2 prints "[PM2] Spawning daemon" banners before the JSON on a cold start.
  const jlistText = (sections.jlist ?? "")
    .split("\n")
    .filter((line) => !line.startsWith("[PM2]"))
    .join("\n")
    .trim();
  const jlist = parseJSON(jlistText);
  if (!Array.isArray(jlist)) {
    throw new Error(
      "Could not read the process list from PM2 on the server (`pm2 jlist` failed) — is PM2 installed? Run `nodeploy doctor`.",
    );
  }

  const processes: PM2LogProcess[] = (jlist as RawJlistProcess[]).map((p) => {
    const env = p.pm2_env ?? {};
    const paths = [env.pm_out_log_path, env.pm_err_log_path, env.pm_log_path];
    return {
      name: p.name ?? "?",
      status: env.status ?? "unknown",
      isModule: Boolean(env.pmx_module || env.axm_options?.isModule),
      logPaths: [...new Set(paths.filter(isRealLogPath))],
    };
  });

  const conf = (parseJSON(sections.conf) ?? {}) as Record<string, unknown>;
  const registry = (conf["module-db-v2"] ?? {}) as Record<string, unknown>;
  const settings = (conf[LOGROTATE_MODULE] ?? {}) as Record<string, unknown>;
  const pkg = parseJSON(sections.package) as { version?: unknown } | null;

  const daemons: PM2Daemon[] = [];
  for (const line of (sections.daemons ?? "").split("\n")) {
    const match = /^\s*(\S+)\s+PM2 v[\w.-]+: God Daemon \((.+)\)/.exec(line);
    if (match) daemons.push({ user: match[1], pm2Home: match[2] });
  }

  const moduleProcess = processes.find((p) => p.name === LOGROTATE_MODULE);

  return {
    pm2Home: sections.home || "~/.pm2",
    installed: Object.hasOwn(registry, LOGROTATE_MODULE),
    version: typeof pkg?.version === "string" ? pkg.version : null,
    moduleStatus: moduleProcess?.status ?? null,
    settings: typeof settings === "object" && settings !== null ? settings : {},
    daemons,
    processes,
  };
}

export async function probeLogRotation(
  target: SSHTarget,
): Promise<LogRotationState> {
  const { stdout } = await sshExec(target, withNvm("sh -s"), {
    input: probeScript(),
  });
  return parseProbe(stdout);
}

/** PM2 daemons other than the SSH user's own: their apps' logs aren't
 * covered by anything nodeploy sets up (each daemon has its own modules). */
export function foreignDaemons(state: LogRotationState): PM2Daemon[] {
  return state.daemons.filter((d) => d.pm2Home !== state.pm2Home);
}

// ─── Settings ──────────────────────────────────────────────────────────────

/** What the server's module is actually configured with. `retain: null`
 * means keep every archive (pm2-logrotate's reading of a non-number). */
export interface ServerRotationSettings {
  maxSize: string;
  retain: number | null;
  compress: boolean;
  interval: number;
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return fallback;
}

function toInt(value: unknown): number | null {
  const n = Number.parseInt(String(value), 10);
  return Number.isNaN(n) ? null : n;
}

/** Reads settings the way pm2-logrotate itself does. */
export function readServerSettings(
  raw: Record<string, unknown>,
): ServerRotationSettings {
  return {
    maxSize:
      raw.max_size === undefined || raw.max_size === ""
        ? MODULE_DEFAULTS.maxSize
        : String(raw.max_size),
    retain:
      raw.retain === undefined ? MODULE_DEFAULTS.retain : toInt(raw.retain),
    compress: toBool(raw.compress, false),
    interval: toInt(raw.workerInterval) ?? MODULE_DEFAULTS.interval,
  };
}

/** Values are stored the way `pm2 set` and the module's own defaults store
 * them. rotateModule also rotates pm2.log and modules' logs; dateFormat is
 * pinned because `nodeploy logs rotate` and retention depend on it. */
export function moduleConf(
  settings: LogRotationConfig,
): Record<string, string | boolean> {
  return {
    max_size: settings.maxSize,
    retain: String(settings.retain),
    compress: settings.compress,
    workerInterval: String(settings.interval),
    rotateModule: true,
    dateFormat: ARCHIVE_DATE_FORMAT,
  };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

export type RotationAction = "none" | "install" | "upgrade" | "restart";

export interface LogRotationPlan {
  /** What the module will run with once the plan is applied. */
  settings: LogRotationConfig;
  /** Full module config to write. */
  conf: Record<string, string | boolean>;
  /** Config keys whose value on the server differs from `conf`. */
  changed: string[];
  action: RotationAction;
  notes: string[];
}

/** Decides what to change on the server. Pure, so idempotence is easy to
 * test: a server already in the desired state plans `none` with no changes. */
export function planLogRotation(
  state: LogRotationState,
  explicit: Partial<LogRotationConfig> = {},
): LogRotationPlan {
  const settings = resolveLogRotation(explicit);
  const notes: string[] = [];

  // Lowering retention deletes archives on the next rotation. Never do that
  // implicitly to a module someone already set up — only when asked to in
  // nodeploy.yml / `nodeploy logs config --retain`.
  if (state.installed && explicit.retain === undefined) {
    const current = readServerSettings(state.settings).retain;
    if (current !== null && current > settings.retain) {
      settings.retain = current;
      notes.push(
        `kept the server's existing retain of ${current} (higher than nodeploy's default ${DEFAULT_LOG_ROTATION.retain}) so no existing archives get deleted — set log_rotation.retain to lower it`,
      );
    } else if (current === null) {
      notes.push(
        `the server kept every rotated archive (no retain limit); now keeping the newest ${settings.retain} per log file`,
      );
    }
  }

  const conf = moduleConf(settings);
  const changed = Object.keys(conf).filter(
    (key) => String(state.settings[key]) !== String(conf[key]),
  );

  let action: RotationAction = "none";
  if (!state.installed && state.moduleStatus !== null) {
    // Running, but not registered as a module (started by hand): installing
    // would launch a second worker rotating the same files. Configure the
    // running one instead.
    notes.push(
      `${LOGROTATE_MODULE} is running but isn't registered as a PM2 module, so it may not come back after a reboot — \`pm2 install ${LOGROTATE_MODULE}@${LOGROTATE_VERSION}\` on the server registers it`,
    );
    if (changed.length > 0 || state.moduleStatus !== "online") action = "restart";
  } else if (!state.installed || state.moduleStatus === null) {
    // Not installed, or registered but PM2 lost the process (e.g. someone
    // ran `pm2 delete pm2-logrotate`): installing (re)launches it.
    action = "install";
  } else if (
    state.version === null ||
    compareVersions(state.version, LOGROTATE_VERSION) < 0
  ) {
    action = "upgrade";
    notes.push(
      `upgrading ${LOGROTATE_MODULE} ${state.version ?? "(unknown version)"} → ${LOGROTATE_VERSION} (older releases ignore \`compress\`)`,
    );
  } else if (changed.length > 0 || state.moduleStatus !== "online") {
    action = "restart";
  }

  return { settings, conf, changed, action, notes };
}

// Merges into module_conf.json rather than calling `pm2 set` once per key:
// each `pm2 set` restarts the module, and before the first install there's
// no module to restart. Writing the settings *before* `pm2 install` also
// matters: install only fills in defaults for keys that aren't set yet, so
// the module's first pass already uses these settings — never its own
// 10M/uncompressed defaults, which would make full-size copies of every big
// existing log. Atomic (temp file + rename), and refuses to overwrite a
// module_conf.json it can't parse.
const WRITE_CONF_SCRIPT = [
  'const fs = require("fs");',
  "const file = process.argv[1];",
  "let conf = {};",
  'try { conf = JSON.parse(fs.readFileSync(file, "utf8")); }',
  'catch (e) { if (e.code !== "ENOENT") throw e; }',
  'const settings = JSON.parse(fs.readFileSync(0, "utf8"));',
  `conf["${LOGROTATE_MODULE}"] = Object.assign({}, conf["${LOGROTATE_MODULE}"], settings);`,
  'fs.writeFileSync(file + ".nodeploy-tmp", JSON.stringify(conf, null, 2));',
  'fs.renameSync(file + ".nodeploy-tmp", file);',
].join(" ");

export async function writeModuleConf(
  target: SSHTarget,
  conf: Record<string, string | boolean>,
): Promise<void> {
  await sshExec(
    target,
    withNvm(
      `mkdir -p ${REMOTE_PM2_HOME} && node -e '${WRITE_CONF_SCRIPT}' ${REMOTE_PM2_HOME}/module_conf.json`,
    ),
    { input: JSON.stringify(conf) },
  );
}

export async function applyLogRotationPlan(
  target: SSHTarget,
  plan: LogRotationPlan,
): Promise<void> {
  if (plan.changed.length > 0) await writeModuleConf(target, plan.conf);

  if (plan.action === "install" || plan.action === "upgrade") {
    // Uses the nvm-resolved npm, as PM2 runs npm from the CLI's own PATH.
    await sshExec(
      target,
      withNvm(`pm2 install ${LOGROTATE_MODULE}@${LOGROTATE_VERSION}`),
    );
  } else if (plan.action === "restart") {
    // --update-env makes PM2 re-read module_conf.json, like `pm2 set` does.
    await sshExec(
      target,
      withNvm(`pm2 restart ${LOGROTATE_MODULE} --update-env`),
    );
  }
}

export type EnsureResult =
  | { status: "disabled"; state: LogRotationState }
  | {
      status: "unchanged" | "installed" | "upgraded" | "updated" | "restarted";
      state: LogRotationState;
      plan: LogRotationPlan;
    };

/** Idempotent: installs pm2-logrotate at most once per PM2 daemon, rewrites
 * config only when it differs, and restarts only the module — never an app.
 * Existing logs aren't touched here; oversized ones are rotated (archived,
 * not deleted) on the module's first pass. */
export async function ensureLogRotation(
  target: SSHTarget,
  explicit: Partial<LogRotationConfig> = {},
  /** Called before anything changes on the server, e.g. to say that an
   * install (which runs npm) is about to happen. */
  onChange?: (plan: LogRotationPlan) => void,
): Promise<EnsureResult> {
  const state = await probeLogRotation(target);
  if (explicit.enabled === false) return { status: "disabled", state };

  const plan = planLogRotation(state, explicit);
  if (plan.action !== "none" || plan.changed.length > 0) onChange?.(plan);
  await applyLogRotationPlan(target, plan);

  const status =
    plan.action === "install"
      ? state.installed
        ? "restarted"
        : "installed"
      : plan.action === "upgrade"
        ? "upgraded"
        : plan.action === "restart"
          ? plan.changed.length > 0
            ? "updated"
            : "restarted"
          : "unchanged";
  return { status, state, plan };
}

// ─── Disk usage ────────────────────────────────────────────────────────────

export interface LogFile {
  path: string;
  bytes: number;
}

export interface DiskInfo {
  sizeBytes: number;
  usedBytes: number;
  availableBytes: number;
  mount: string;
}

export interface LogListing {
  files: LogFile[];
  /** Directories that couldn't be listed (missing or no permission). */
  errors: string[];
  disk: DiskInfo | null;
}

const ARCHIVE_PATTERN =
  /^(.+)__\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(\.[^.]+)?(\.gz)?$/;

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The live log an archive was rotated from, or null if `path` isn't an
 * archive. `api-out__2026-11-17_10-00-00.log.gz` → `api-out.log`. */
export function archiveSource(path: string): string | null {
  const match = ARCHIVE_PATTERN.exec(basename(path));
  if (!match) return null;
  return `${dirname(path)}/${match[1]}${match[2] ?? ""}`;
}

/** Every log a PM2 daemon writes: its apps' (and modules') logs plus its
 * own pm2.log. */
export function liveLogPaths(state: LogRotationState): string[] {
  return [
    ...new Set([
      ...state.processes.flatMap((p) => p.logPaths),
      `${state.pm2Home}/pm2.log`,
    ]),
  ];
}

export function listingScript(dirs: string[], pm2Home: string): string {
  return [
    ...dirs.map(
      (dir) =>
        `echo "${SECTION} dir ${dir}"; LC_ALL=C ls -ln -- ${shellQuote(dir)} 2>&1`,
    ),
    `echo "${SECTION} df"; df -Pk -- ${shellQuote(pm2Home)} 2>/dev/null | tail -n 1`,
    "",
  ].join("\n");
}

const LS_LINE =
  /^(\S)\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s(.+)$/;

/** Parses `ls -ln` per directory (sizes without needing read permission on
 * each file — ls only needs the directory) and `df -Pk`. Keeps every file
 * in PM2's logs dir; elsewhere (pm2.log's home dir, custom log paths) only
 * the live logs PM2 writes and their archives. */
export function parseListing(
  stdout: string,
  logsDir: string,
  live: string[],
): LogListing {
  const liveSet = new Set(live);
  const files: LogFile[] = [];
  const errors: string[] = [];
  let disk: DiskInfo | null = null;
  let dir: string | null = null;

  for (const line of stdout.split("\n")) {
    if (line.startsWith(`${SECTION} dir `)) {
      dir = line.slice(`${SECTION} dir `.length);
      continue;
    }
    if (line.startsWith(`${SECTION} df`)) {
      dir = null;
      continue;
    }
    if (dir === null) {
      const df = /^\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.+)$/.exec(line.trim());
      if (df) {
        disk = {
          sizeBytes: Number(df[1]) * 1024,
          usedBytes: Number(df[2]) * 1024,
          availableBytes: Number(df[3]) * 1024,
          mount: df[4],
        };
      }
      continue;
    }
    if (line.startsWith("ls:")) {
      errors.push(line.replace(/^ls:\s*/, ""));
      continue;
    }
    const match = LS_LINE.exec(line);
    if (!match || match[1] !== "-") continue; // "total N", dirs, symlinks
    const path = `${dir}/${match[3]}`;
    const source = archiveSource(path);
    if (dir === logsDir || liveSet.has(path) || (source && liveSet.has(source))) {
      files.push({ path, bytes: Number(match[2]) });
    }
  }

  return { files, errors, disk };
}

export async function listLogFiles(
  target: SSHTarget,
  state: LogRotationState,
): Promise<LogListing> {
  const logsDir = `${state.pm2Home}/logs`;
  const live = liveLogPaths(state);
  const dirs = [...new Set([logsDir, ...live.map(dirname)])];
  const { stdout } = await sshExec(target, "sh -s", {
    input: listingScript(dirs, state.pm2Home),
  });
  return parseListing(stdout, logsDir, live);
}

export interface AppLogUsage {
  /** PM2 process name, "pm2 daemon", or a file name for unowned logs. */
  name: string;
  /** False for logs of apps PM2 no longer runs. */
  inPM2: boolean;
  liveBytes: number;
  archiveBytes: number;
  archives: number;
}

export interface LogUsage {
  totalBytes: number;
  apps: AppLogUsage[];
  largest: LogFile[];
  /** Live logs and their sizes, for spotting ones rotation isn't keeping up with. */
  live: LogFile[];
}

const PM2_LOG_NAME = /^(.+?)-(out|error)(-\d+)?\.log$/;

export function summarizeLogUsage(
  files: LogFile[],
  state: LogRotationState,
): LogUsage {
  const owner = new Map<string, string>();
  for (const p of state.processes) {
    for (const path of p.logPaths) owner.set(path, p.name);
  }
  for (const name of ["pm2.log", "agent.log"]) {
    owner.set(`${state.pm2Home}/${name}`, "pm2 daemon");
  }

  const apps = new Map<string, AppLogUsage>();
  const live: LogFile[] = [];
  for (const file of files) {
    const source = archiveSource(file.path);
    const livePath = source ?? file.path;
    let name = owner.get(livePath);
    const inPM2 = name !== undefined;
    if (!name) {
      const base = basename(livePath);
      name = PM2_LOG_NAME.exec(base)?.[1] ?? base;
    }

    const usage = apps.get(name) ?? {
      name,
      inPM2,
      liveBytes: 0,
      archiveBytes: 0,
      archives: 0,
    };
    if (source) {
      usage.archiveBytes += file.bytes;
      usage.archives += 1;
    } else {
      usage.liveBytes += file.bytes;
      live.push(file);
    }
    apps.set(name, usage);
  }

  const total = (u: AppLogUsage) => u.liveBytes + u.archiveBytes;
  return {
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
    apps: [...apps.values()].sort((a, b) => total(b) - total(a)),
    largest: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 5),
    live,
  };
}

/** Logs take this share of their filesystem → "unusually high". */
const LOG_SHARE_WARNING = 0.1;
/** Filesystem this full → warn, whatever is using it. */
const DISK_USED_WARNING = 0.9;

export function logUsageWarnings(
  usage: LogUsage,
  disk: DiskInfo | null,
  maxSize: string,
  rotating: boolean,
): string[] {
  const warnings: string[] = [];
  const limit = parseMaxSize(maxSize) ?? Infinity;

  // The module checks every `interval` seconds, so a live log only ends up
  // well past max_size when nothing is rotating it.
  for (const file of usage.live) {
    if (file.bytes >= limit * 2) {
      warnings.push(
        rotating
          ? `${file.path} is ${formatBytes(file.bytes)}, over twice max_size (${maxSize}) — rotation isn't keeping up; check \`pm2 logs ${LOGROTATE_MODULE}\` on the server`
          : `${file.path} is ${formatBytes(file.bytes)} and nothing is rotating it — run \`nodeploy logs setup\``,
      );
    }
  }

  if (disk && disk.sizeBytes > 0) {
    if (usage.totalBytes >= disk.sizeBytes * LOG_SHARE_WARNING) {
      warnings.push(
        `PM2 logs take ${formatBytes(usage.totalBytes)}, ${Math.round((usage.totalBytes / disk.sizeBytes) * 100)}% of ${disk.mount} — unusually high`,
      );
    }
    if (disk.usedBytes >= disk.sizeBytes * DISK_USED_WARNING) {
      warnings.push(
        `${disk.mount} is ${Math.round((disk.usedBytes / disk.sizeBytes) * 100)}% full (${formatBytes(disk.availableBytes)} free)`,
      );
    }
  }

  return warnings;
}

// ─── Manual rotation ───────────────────────────────────────────────────────

export interface RotateTarget {
  path: string;
  /** "move": rename, then `pm2 reloadLogs` reopens it — loses nothing, for
   * app logs PM2 holds open. "copy": copy then truncate, for pm2.log, which
   * the daemon writes to directly and can't reopen. */
  mode: "move" | "copy";
}

export interface RotateOptions {
  compress: boolean;
  retain: number;
}

/** A POSIX sh script that rotates `targets` now, regardless of size. Each
 * output line is tab-separated: `rotated <log> <archive>`, `skipped <log>
 * <reason>`, `deleted <archive>`, `error <log> <message>`. Every file is
 * handled independently: a missing file or a permission error skips that
 * file and carries on. */
export function buildRotateScript(
  targets: RotateTarget[],
  opts: RotateOptions,
): string {
  const calls = targets.map(
    (t) => `${t.mode === "move" ? "move_log" : "copy_log"} ${shellQuote(t.path)}`,
  );
  const prunes = targets.map((t) => `prune ${shellQuote(t.path)}`);

  return `set -u
compress=${opts.compress ? 1 : 0}
retain=${opts.retain}
ts=$(date +%Y-%m-%d_%H-%M-%S)
moved=$(mktemp) || exit 1
trap 'rm -f "$moved"' EXIT
TAB=$(printf '\\t')

# api-out.log -> stem=api-out ext=.log (like node's path.extname)
split_name() {
  dir=$(dirname -- "$1"); base=$(basename -- "$1")
  case "$base" in
    ?*.*) ext=".\${base##*.}"; stem=\${base%.*} ;;
    *) ext=""; stem=$base ;;
  esac
}

check_log() {
  if [ ! -e "$1" ]; then printf 'skipped\\t%s\\tmissing\\n' "$1"; return 1; fi
  if [ ! -s "$1" ]; then printf 'skipped\\t%s\\tempty\\n' "$1"; return 1; fi
  split_name "$1"
  archive="$dir/\${stem}__$ts$ext"
  if [ -e "$archive" ] || [ -e "$archive.gz" ]; then
    printf 'skipped\\t%s\\talready rotated this second\\n' "$1"; return 1
  fi
}

# PM2 keeps writing to the renamed file until reloadLogs reopens the path,
# so nothing written meanwhile is lost.
move_log() {
  check_log "$1" || return 0
  if err=$(mv -- "$1" "$archive" 2>&1); then
    printf '%s\\t%s\\n' "$1" "$archive" >> "$moved"
  else
    printf 'error\\t%s\\t%s\\n' "$1" "$err"
  fi
}

copy_log() {
  check_log "$1" || return 0
  if [ "$compress" = 1 ]; then out="$archive.gz"; else out="$archive"; fi
  if { if [ "$compress" = 1 ]; then gzip -c -- "$1" > "$out"; else cp -p -- "$1" "$out"; fi; } 2>/dev/null; then
    if { : > "$1"; } 2>/dev/null; then
      printf 'rotated\\t%s\\t%s\\n' "$1" "$out"
    else
      rm -f -- "$out"; printf 'error\\t%s\\tno permission to truncate it\\n' "$1"
    fi
  else
    rm -f -- "$out"; printf 'error\\t%s\\tcould not write the archive (disk full or no permission)\\n' "$1"
  fi
}

prune() {
  split_name "$1"
  for a in "$dir/$stem"__*; do
    [ -f "$a" ] || continue
    case "$a" in *"$ext"|*"$ext.gz") printf '%s\\n' "$a" ;; esac
  done | sort -r | sed "1,\${retain}d" | while IFS= read -r a; do
    rm -f -- "$a" 2>/dev/null && printf 'deleted\\t%s\\n' "$a"
  done
}

${calls.join("\n")}

if [ -s "$moved" ]; then
  if pm2 reloadLogs >/dev/null 2>&1; then
    sleep 1 # let PM2 flush what it buffered for the old files
    while IFS="$TAB" read -r log archive; do
      if [ "$compress" = 1 ]; then
        if gzip -- "$archive" 2>/dev/null; then archive="$archive.gz"
        else printf 'error\\t%s\\tcould not compress %s (kept uncompressed)\\n' "$log" "$archive"; fi
      fi
      printf 'rotated\\t%s\\t%s\\n' "$log" "$archive"
    done < "$moved"
  else
    # Apps still write to the renamed files: put them back.
    while IFS="$TAB" read -r log archive; do
      if [ ! -e "$log" ] && mv -- "$archive" "$log" 2>/dev/null; then
        printf 'error\\t%s\\tpm2 reloadLogs failed, left as it was\\n' "$log"
      else
        printf 'error\\t%s\\tpm2 reloadLogs failed; the app keeps writing to %s until it restarts\\n' "$log" "$archive"
      fi
    done < "$moved"
    exit 0
  fi
fi

${prunes.join("\n")}
`;
}

export interface RotateResult {
  rotated: { log: string; archive: string }[];
  skipped: { log: string; reason: string }[];
  deleted: string[];
  errors: { log: string; message: string }[];
}

export function parseRotateOutput(stdout: string): RotateResult {
  const result: RotateResult = {
    rotated: [],
    skipped: [],
    deleted: [],
    errors: [],
  };
  for (const line of stdout.split("\n")) {
    const [kind, a = "", b = ""] = line.split("\t");
    if (kind === "rotated") result.rotated.push({ log: a, archive: b });
    else if (kind === "skipped") result.skipped.push({ log: a, reason: b });
    else if (kind === "deleted") result.deleted.push(a);
    else if (kind === "error") result.errors.push({ log: a, message: b });
  }
  return result;
}

export async function rotateLogsNow(
  target: SSHTarget,
  targets: RotateTarget[],
  opts: RotateOptions,
): Promise<RotateResult> {
  const { stdout } = await sshExec(target, withNvm("sh -s"), {
    input: buildRotateScript(targets, opts),
  });
  return parseRotateOutput(stdout);
}

// ─── Presentation ──────────────────────────────────────────────────────────

export function describeSettings(s: {
  maxSize: string;
  retain: number | null;
  compress: boolean;
  interval: number;
}): string {
  const keep =
    s.retain === null ? "keep every archive" : `keep ${s.retain} per log`;
  return `rotate at ${s.maxSize}, ${keep}${s.compress ? " (gzip)" : " (uncompressed)"}, checked every ${s.interval}s`;
}

export interface Message {
  level: "success" | "info" | "warn";
  text: string;
}

/** What `setup`/`deploy`/`logs setup` print after ensureLogRotation. */
export function describeEnsureResult(
  result: EnsureResult,
  user: string,
): Message[] {
  const messages: Message[] = [];
  const { state } = result;

  if (result.status === "disabled") {
    messages.push(
      state.installed
        ? {
            level: "warn",
            text: `log_rotation.enabled is false, but ${LOGROTATE_MODULE} is installed in ${state.pm2Home} and still rotates every app on this PM2 — nodeploy leaves it alone; run \`pm2 uninstall ${LOGROTATE_MODULE}\` on the server to remove it`,
          }
        : {
            level: "warn",
            text: "Log rotation is off (log_rotation.enabled: false) — PM2 logs on this server grow without limit",
          },
    );
  } else {
    const what = describeSettings(result.plan.settings);
    const scope = `every app on ${user}'s PM2, plus pm2.log`;
    const text = {
      installed: `Log rotation installed (${LOGROTATE_MODULE} ${LOGROTATE_VERSION}): ${what} — covers ${scope}`,
      upgraded: `Log rotation upgraded to ${LOGROTATE_MODULE} ${LOGROTATE_VERSION}: ${what}`,
      updated: `Log rotation updated (${result.plan.changed.join(", ")}): ${what}`,
      restarted: `Log rotation restarted: ${what}`,
      unchanged: `Log rotation already set up: ${what}`,
    }[result.status];
    messages.push({ level: "success", text });
    for (const note of result.plan.notes) {
      messages.push({ level: "info", text: `  ${note}` });
    }
  }

  for (const daemon of foreignDaemons(state)) {
    messages.push({
      level: "warn",
      text: `Another PM2 daemon runs as ${daemon.user} (${daemon.pm2Home}) — nodeploy only manages ${user}'s (${state.pm2Home}), so that daemon's apps aren't covered. Point an app's ssh.user at ${daemon.user} and run \`nodeploy logs setup\` to cover it too.`,
    });
  }

  return messages;
}

/** Live logs already past max_size: the module archives each on its first
 * pass, which needs free space for the (compressed) copy. */
export function firstPassWarnings(
  listing: LogListing,
  usage: LogUsage,
  maxSize: string,
  compress: boolean,
): string[] {
  const limit = parseMaxSize(maxSize) ?? Infinity;
  const oversized = usage.live.filter((f) => f.bytes >= limit);
  if (oversized.length === 0) return [];

  const total = oversized.reduce((sum, f) => sum + f.bytes, 0);
  const warnings = [
    `${oversized.length} log(s) are already over ${maxSize} (${formatBytes(total)} in all); the first rotation archives${compress ? " and compresses" : ""} them — nothing is deleted`,
  ];
  // gzip typically shrinks logs 5-10×; uncompressed archives are full copies.
  const needed = compress ? total / 4 : total;
  if (listing.disk && listing.disk.availableBytes < needed) {
    warnings.push(
      `only ${formatBytes(listing.disk.availableBytes)} free on ${listing.disk.mount}, which may not fit the archives — free some space first (e.g. \`: > <file>\` on the server empties a log you don't need)`,
    );
  }
  return warnings;
}
