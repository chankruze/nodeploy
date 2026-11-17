import type { Command } from "commander";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import {
  loadDeployConfig,
  toSSHTarget,
  updateLogRotationConfig,
  validateLogRotation,
} from "../lib/deployConfig.js";
import { formatBytes } from "../lib/format.js";
import { fail, info, success, warn } from "../lib/logger.js";
import {
  LOGROTATE_MODULE,
  type LogRotationState,
  type Message,
  type RotateTarget,
  describeEnsureResult,
  describeSettings,
  ensureLogRotation,
  firstPassWarnings,
  foreignDaemons,
  listLogFiles,
  logUsageWarnings,
  planLogRotation,
  probeLogRotation,
  readServerSettings,
  resolveLogRotation,
  rotateLogsNow,
  summarizeLogUsage,
} from "../lib/logRotation.js";
import { isStaticSiteEnabled } from "../lib/nginx.js";
import { createPM2Adapter } from "../lib/pm2.js";
import type { DeployConfig, LogRotationConfig, SSHTarget } from "../types.js";

interface LogsOptions {
  lines?: string;
}

interface ConfigOptions {
  maxSize?: string;
  retain?: string;
  interval?: string;
  compress?: boolean;
  enable?: boolean;
  disable?: boolean;
}

interface RotateOptions {
  all?: boolean;
}

export function printMessages(messages: Message[]): void {
  for (const { level, text } of messages) {
    if (level === "success") success(text);
    else if (level === "warn") warn(text);
    else info(text);
  }
}

/** Loads nodeploy.yml for a command that needs PM2, or explains why there
 * is none (runtime: external) and returns null. */
function loadPM2App(): { config: DeployConfig; target: SSHTarget } | null {
  const config = loadDeployConfig(process.cwd(), DEPLOY_CONFIG_FILENAME);
  if (config.runtime === "external") {
    fail(
      `${config.service} is run by another tool (runtime: external), not PM2 — nodeploy doesn't manage its logs; use that tool's log settings (e.g. Docker's log-opts for Kamal).`,
    );
    process.exitCode = 1;
    return null;
  }
  return { config, target: toSSHTarget(config) };
}

/** `setup`, `deploy`, `logs setup`, and `logs config` all apply rotation the
 * same way. Returns false if it couldn't be applied. */
export async function applyLogRotation(
  config: DeployConfig,
  target: SSHTarget,
  opts: { quietIfUnchanged?: boolean; checkExistingLogs?: boolean } = {},
): Promise<boolean> {
  try {
    const result = await ensureLogRotation(target, config.logRotation, (plan) => {
      if (plan.action === "install" || plan.action === "upgrade") {
        info(`  Installing ${LOGROTATE_MODULE} on ${config.server}'s PM2 (via npm)...`);
      }
    });

    const messages = describeEnsureResult(result, target.user);
    const quiet =
      opts.quietIfUnchanged &&
      result.status === "unchanged" &&
      messages.every((m) => m.level !== "warn");
    if (!quiet) printMessages(messages.map((m) => ({ ...m, text: `  ${m.text}` })));

    if (opts.checkExistingLogs && result.status !== "disabled") {
      const listing = await listLogFiles(target, result.state);
      const usage = summarizeLogUsage(listing.files, result.state);
      const { maxSize, compress } = result.plan.settings;
      for (const text of firstPassWarnings(listing, usage, maxSize, compress)) {
        warn(`  ${text}`);
      }
    }
    return true;
  } catch (error) {
    warn(
      `  Could not set up log rotation on ${config.server} — PM2 logs there aren't size-limited until this is fixed (\`nodeploy logs setup\` retries). (${error instanceof Error ? error.message : String(error)})`,
    );
    return false;
  }
}

function moduleLine(state: LogRotationState): string {
  if (!state.installed && state.moduleStatus === null) return "not installed";
  const version = state.version ?? "unknown version";
  const status = state.moduleStatus ?? "not running";
  return `${LOGROTATE_MODULE} ${version}, ${status}${state.installed ? "" : " (not registered as a PM2 module)"}`;
}

/** Settings on the server that differ from what nodeploy.yml asks for. */
function driftFrom(
  state: LogRotationState,
  explicit: Partial<LogRotationConfig> | undefined,
): string[] {
  const plan = planLogRotation(state, explicit);
  const server = readServerSettings(state.settings);
  const wanted = plan.settings;
  const drift: string[] = [];
  if (server.maxSize !== wanted.maxSize) drift.push(`max_size ${server.maxSize} → ${wanted.maxSize}`);
  if (server.retain !== wanted.retain) drift.push(`retain ${server.retain ?? "all"} → ${wanted.retain}`);
  if (server.compress !== wanted.compress) drift.push(`compress ${server.compress} → ${wanted.compress}`);
  if (server.interval !== wanted.interval) drift.push(`interval ${server.interval}s → ${wanted.interval}s`);
  if (plan.action === "upgrade") drift.push("module version");
  return drift;
}

function registerStatus(logs: Command): void {
  logs
    .command("status")
    .description("Show whether log rotation is installed and running on the server, and with what settings")
    .action(async () => {
      const app = loadPM2App();
      if (!app) return;
      const { config, target } = app;

      const state = await probeLogRotation(target);
      const rotating = state.moduleStatus === "online";
      const server = readServerSettings(state.settings);

      info(`Log rotation on ${config.server} (PM2 home ${state.pm2Home}):`);
      info(`  module:   ${rotating ? "🟢" : "🔴"} ${moduleLine(state)}`);
      if (state.installed || state.moduleStatus !== null) {
        info(`  settings: ${describeSettings(server)}`);
      }

      if (config.logRotation?.enabled === false) {
        info(`  nodeploy.yml: log_rotation.enabled is false — nodeploy doesn't manage rotation here`);
      } else if (!state.installed && state.moduleStatus === null) {
        warn("  Not set up yet — run `nodeploy logs setup` (or `nodeploy setup`)");
      } else {
        const drift = driftFrom(state, config.logRotation);
        if (drift.length === 0) info("  nodeploy.yml: matches the server");
        else warn(`  Differs from nodeploy.yml (${drift.join(", ")}) — run \`nodeploy logs setup\` to apply`);
      }

      const listing = await listLogFiles(target, state);
      const usage = summarizeLogUsage(listing.files, state);
      const archives = usage.apps.reduce((n, a) => n + a.archives, 0);
      info(
        `  logs:     ${formatBytes(usage.totalBytes)} in ${listing.files.length} file(s), ${archives} of them rotated archives — \`nodeploy logs usage\` for details`,
      );

      for (const text of logUsageWarnings(usage, listing.disk, server.maxSize, rotating)) {
        warn(`  ${text}`);
      }
      for (const daemon of foreignDaemons(state)) {
        warn(
          `  Another PM2 daemon runs as ${daemon.user} (${daemon.pm2Home}); its apps' logs aren't covered by this one's rotation`,
        );
      }
    });
}

function parseConfigOptions(options: ConfigOptions): Partial<LogRotationConfig> {
  if (options.enable && options.disable) {
    throw new Error("--enable and --disable can't be used together");
  }
  const raw: Record<string, unknown> = {};
  if (options.maxSize !== undefined) raw.max_size = options.maxSize;
  if (options.retain !== undefined) raw.retain = Number(options.retain);
  if (options.interval !== undefined) raw.interval = Number(options.interval);
  if (options.compress !== undefined) raw.compress = options.compress;
  if (options.enable) raw.enabled = true;
  if (options.disable) raw.enabled = false;
  return validateLogRotation(raw);
}

function registerConfig(logs: Command): void {
  logs
    .command("config")
    .description(
      "Show the log rotation settings, or change them: updates log_rotation in nodeploy.yml and applies it to the server",
    )
    .option("--max-size <size>", "rotate a log once it reaches this size, e.g. 50M, 1G")
    .option("--retain <count>", "rotated archives to keep per log file")
    .option("--interval <seconds>", "how often to check log sizes")
    .option("--compress", "gzip rotated archives")
    .option("--no-compress", "keep rotated archives uncompressed")
    .option("--enable", "let nodeploy install and manage log rotation")
    .option("--disable", "stop nodeploy managing log rotation (leaves the server as it is)")
    .action(async (options: ConfigOptions) => {
      const changes = parseConfigOptions(options);
      let app = loadPM2App();
      if (!app) return;

      if (Object.keys(changes).length > 0) {
        const config = updateLogRotationConfig(process.cwd(), DEPLOY_CONFIG_FILENAME, changes);
        success(`Updated log_rotation in ${DEPLOY_CONFIG_FILENAME}`);
        app = { config, target: app.target };
        const applied = await applyLogRotation(config, app.target);
        if (!applied) process.exitCode = 1;
        return;
      }

      const { config, target } = app;
      const explicit = config.logRotation ?? {};
      const wanted = resolveLogRotation(explicit);
      const source = (key: keyof LogRotationConfig) =>
        explicit[key] === undefined ? " (default)" : "";

      info(`${DEPLOY_CONFIG_FILENAME} log_rotation:`);
      info(`  enabled:  ${wanted.enabled}${source("enabled")}`);
      info(`  max_size: ${wanted.maxSize}${source("maxSize")}`);
      info(`  retain:   ${wanted.retain}${source("retain")}`);
      info(`  compress: ${wanted.compress}${source("compress")}`);
      info(`  interval: ${wanted.interval}s${source("interval")}`);

      const state = await probeLogRotation(target);
      if (!state.installed && state.moduleStatus === null) {
        info(`On ${config.server}: not installed`);
      } else {
        info(`On ${config.server} (shared by every app on ${target.user}'s PM2):`);
        info(`  ${describeSettings(readServerSettings(state.settings))}`);
      }
      info("Change with e.g. `nodeploy logs config --max-size 100M --retain 10`.");
    });
}

function registerSetup(logs: Command): void {
  logs
    .command("setup")
    .description(
      "Install and configure log rotation on the server now, for every app its PM2 runs — no redeploy needed (setup and deploy also do this)",
    )
    .action(async () => {
      const app = loadPM2App();
      if (!app) return;
      info(`Setting up log rotation on ${app.config.server}...`);
      const applied = await applyLogRotation(app.config, app.target, {
        checkExistingLogs: true,
      });
      if (!applied) process.exitCode = 1;
    });
}

function registerUsage(logs: Command): void {
  logs
    .command("usage")
    .description("Show how much disk PM2's logs use on the server, per app, and the largest files")
    .action(async () => {
      const app = loadPM2App();
      if (!app) return;
      const { config, target } = app;

      const state = await probeLogRotation(target);
      const listing = await listLogFiles(target, state);
      const usage = summarizeLogUsage(listing.files, state);
      const server = readServerSettings(state.settings);
      const rotating = state.moduleStatus === "online";

      const disk = listing.disk
        ? `; ${listing.disk.mount} is ${Math.round((listing.disk.usedBytes / listing.disk.sizeBytes) * 100)}% full (${formatBytes(listing.disk.availableBytes)} free)`
        : "";
      info(`PM2 logs on ${config.server} (${state.pm2Home}): ${formatBytes(usage.totalBytes)}${disk}`);

      if (usage.apps.length > 0) {
        const width = Math.max(4, ...usage.apps.map((a) => a.name.length + (a.inPM2 ? 0 : 13)));
        info("");
        info(`  ${"APP".padEnd(width)}  ${"LIVE".padStart(9)}  ${"ARCHIVES".padStart(18)}  ${"TOTAL".padStart(9)}`);
        for (const a of usage.apps) {
          const name = a.inPM2 ? a.name : `${a.name} (not in PM2)`;
          const archives = a.archives > 0 ? `${a.archives} (${formatBytes(a.archiveBytes)})` : "-";
          info(
            `  ${name.padEnd(width)}  ${formatBytes(a.liveBytes).padStart(9)}  ${archives.padStart(18)}  ${formatBytes(a.liveBytes + a.archiveBytes).padStart(9)}`,
          );
        }
        info("");
        info("Largest files:");
        for (const file of usage.largest) {
          info(`  ${formatBytes(file.bytes).padStart(9)}  ${file.path}`);
        }
      }

      info("");
      info(
        rotating
          ? `Rotation: ${describeSettings(server)}`
          : "Rotation: not running — run `nodeploy logs setup`",
      );
      for (const error of listing.errors) warn(`Could not list ${error}`);
      for (const text of logUsageWarnings(usage, listing.disk, server.maxSize, rotating)) {
        warn(text);
      }
    });
}

function registerRotate(logs: Command): void {
  logs
    .command("rotate")
    .description(
      "Rotate this app's logs now, whatever their size (no restart, nothing lost); --all for every app on the server's PM2 and pm2.log",
    )
    .option("--all", "rotate every PM2 app's logs and pm2.log, not just this app's", false)
    .action(async (options: RotateOptions) => {
      const app = loadPM2App();
      if (!app) return;
      const { config, target } = app;

      const state = await probeLogRotation(target);
      let targets: RotateTarget[];
      if (options.all) {
        targets = [
          ...new Set(state.processes.flatMap((p) => p.logPaths)),
        ].map((path) => ({ path, mode: "move" as const }));
        targets.push({ path: `${state.pm2Home}/pm2.log`, mode: "copy" });
      } else {
        const proc = state.processes.find((p) => p.name === config.service);
        if (!proc) {
          fail(`${config.service} isn't running under PM2 on ${config.server} — nothing to rotate (use --all for every app)`);
          process.exitCode = 1;
          return;
        }
        targets = proc.logPaths.map((path) => ({ path, mode: "move" as const }));
      }

      // Same retention/compression as automatic rotation, so the two agree.
      const { compress, retain } = planLogRotation(state, config.logRotation).settings;
      const result = await rotateLogsNow(target, targets, { compress, retain });

      for (const r of result.rotated) success(`${r.log} → ${r.archive}`);
      for (const s of result.skipped) info(`  skipped ${s.log} (${s.reason})`);
      for (const e of result.errors) fail(`${e.log}: ${e.message}`);
      if (result.deleted.length > 0) {
        info(`Deleted ${result.deleted.length} archive(s) beyond retain (${retain})`);
      }
      if (result.rotated.length === 0 && result.errors.length === 0) {
        info("Nothing to rotate — the logs are empty");
      }
      if (result.errors.length > 0) process.exitCode = 1;
    });
}

export function registerLogsCommand(program: Command): void {
  const logs = program
    .command("logs")
    .description(
      "Stream logs for the app in the current directory via PM2; subcommands manage log rotation and disk usage",
    )
    .option("--lines <count>", "number of lines to show")
    .addHelpText(
      "after",
      "\nLog rotation applies to the whole PM2 daemon of ssh.user: every app it runs, plus pm2.log.",
    )
    .action(async (options: LogsOptions) => {
      const config = loadDeployConfig(process.cwd(), DEPLOY_CONFIG_FILENAME);
      const target = toSSHTarget(config);

      if (config.runtime === "external") {
        fail(
          `${config.service} is run by another tool (runtime: external), not PM2 — use that tool to stream logs for it (e.g. \`kamal app logs -f\`).`,
        );
        process.exitCode = 1;
        return;
      }

      const processes = await createPM2Adapter(target).list();
      const isPM2Managed = processes.some((p) => p.name === config.service);

      if (!isPM2Managed && (await isStaticSiteEnabled(target, config.service))) {
        fail(
          `${config.service} is a static app served directly by nginx — there's no PM2 process to stream logs from. Check /var/log/nginx/access.log and error.log on the server instead.`,
        );
        process.exitCode = 1;
        return;
      }

      const lines = options.lines ? Number(options.lines) : undefined;
      await createPM2Adapter(target).logs(config.service, { lines });
    });

  registerStatus(logs);
  registerConfig(logs);
  registerSetup(logs);
  registerUsage(logs);
  registerRotate(logs);
}
