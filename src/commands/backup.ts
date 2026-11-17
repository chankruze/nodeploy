import type { Command } from "commander";
import { version } from "../../package.json";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import {
  type BackupReason,
  type BackupRunResult,
  listBackups,
  restoreArchive,
  runBackup,
  setupBackups,
} from "../lib/backup.js";
import { loadDeployConfig, toSSHTarget } from "../lib/deployConfig.js";
import { formatBytes } from "../lib/format.js";
import { fail, info, success, warn } from "../lib/logger.js";
import { createPM2Adapter } from "../lib/pm2.js";
import { confirmByTyping } from "../lib/prompt.js";
import type { DeployConfig, SSHTarget } from "../types.js";

interface RestoreOptions {
  yes?: boolean;
}

/** nodeploy.yml for a command that needs a `backup` block, or null after
 * explaining what's missing. */
function loadBackupApp(): { config: DeployConfig & { backup: NonNullable<DeployConfig["backup"]> }; target: SSHTarget } | null {
  const config = loadDeployConfig(process.cwd(), DEPLOY_CONFIG_FILENAME);
  if (config.runtime === "external") {
    fail(`${config.service} is run by another tool (runtime: external) — back its data up with that tool.`);
    process.exitCode = 1;
    return null;
  }
  if (!config.backup) {
    fail(
      `No \`backup\` block in ${DEPLOY_CONFIG_FILENAME}. Add the app's data paths (relative to deploy_path), e.g.:\n  backup:\n    paths: [data/app.db, uploads]`,
    );
    process.exitCode = 1;
    return null;
  }
  return { config: config as DeployConfig & { backup: NonNullable<DeployConfig["backup"]> }, target: toSSHTarget(config) };
}

/** `setup`, `deploy`, and `backup setup` install the script and schedule
 * the same way. Returns false if that failed. */
export async function applyBackupSetup(
  config: DeployConfig,
  target: SSHTarget,
  opts: { quiet?: boolean } = {},
): Promise<boolean> {
  if (!config.backup) return true;
  try {
    const { cron, warnings } = await setupBackups(
      target,
      config.service,
      config.deployPath,
      config.backup,
      version,
    );
    if (!opts.quiet) {
      const when = cron ? cron.split(" /bin/sh")[0] : null;
      success(
        `  Backups set up for ${config.service}: ${config.backup.paths.join(", ")} — ${when ? `${config.backup.schedule} (cron: ${when})` : "no schedule (schedule: off)"}, keeping ${config.backup.keep}`,
      );
    }
    for (const w of warnings) warn(`  ${w}`);
    return true;
  } catch (error) {
    warn(`  Could not set up backups for ${config.service} — run \`nodeploy backup setup\` to retry. (${(error as Error).message})`);
    return false;
  }
}

export function reportBackup(result: BackupRunResult, indent = ""): boolean {
  for (const m of result.missing) warn(`${indent}${m} doesn't exist on the server — not backed up`);
  for (const w of result.warnings) warn(`${indent}${w}`);
  if (result.error || !result.archive) {
    fail(`${indent}Backup failed: ${result.error ?? "no archive was written"}`);
    return false;
  }
  success(`${indent}Backed up to ${result.archive} (${formatBytes(result.bytes)})`);
  if (result.pruned.length > 0) info(`${indent}Deleted ${result.pruned.length} old backup(s) beyond keep`);
  return true;
}

/** Runs a backup through the installed script, (re)installing it first so a
 * changed nodeploy.yml is always honoured. */
export async function backupNow(
  config: DeployConfig,
  target: SSHTarget,
  reason: BackupReason,
): Promise<BackupRunResult> {
  await applyBackupSetup(config, target, { quiet: true });
  return runBackup(target, config.service, reason);
}

export function registerBackupCommand(program: Command): void {
  const backup = program
    .command("backup")
    .description(
      "Back up the app's data (the `backup` block in nodeploy.yml) on the server: on a schedule, on demand, and before every deploy",
    );

  backup
    .command("setup")
    .description("Install the backup script and schedule on the server (setup and deploy also do this)")
    .action(async () => {
      const app = loadBackupApp();
      if (!app) return;
      if (!(await applyBackupSetup(app.config, app.target))) process.exitCode = 1;
    });

  backup
    .command("now")
    .description("Back up the app's data right now")
    .action(async () => {
      const app = loadBackupApp();
      if (!app) return;
      info(`Backing up ${app.config.service} on ${app.config.server}...`);
      const result = await backupNow(app.config, app.target, "manual");
      if (!reportBackup(result)) process.exitCode = 1;
    });

  backup
    .command("list")
    .description("List the app's backups on the server, newest first, and its schedule")
    .action(async () => {
      const app = loadBackupApp();
      if (!app) return;
      const { config, target } = app;
      const { entries, cron, dir } = await listBackups(target, config.service);
      info(`Backups of ${config.service} on ${config.server} (${dir}):`);
      info(
        cron
          ? `  schedule: ${cron.split(" /bin/sh")[0]} (${config.backup.schedule}), keeping ${config.backup.keep}`
          : config.backup.schedule === "off"
            ? `  schedule: off (only on demand and before deploys), keeping ${config.backup.keep}`
            : "  schedule: not installed on the server — run `nodeploy backup setup`",
      );
      if (entries.length === 0) {
        info("  no backups yet — `nodeploy backup now` takes one");
        return;
      }
      for (const e of entries) {
        info(`  ${e.created}  ${e.reason.padEnd(11)}  ${formatBytes(e.bytes).padStart(9)}  ${e.name}`);
      }
    });

  backup
    .command("restore [backup]")
    .description(
      "Restore the app's data from a backup (a name from `backup list`, or \"latest\"): backs up the current data first, stops the app, restores, starts it again",
    )
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action(async (name: string | undefined, options: RestoreOptions) => {
      const app = loadBackupApp();
      if (!app) return;
      const { config, target } = app;

      const { entries } = await listBackups(target, config.service);
      const chosen =
        !name || name === "latest"
          ? entries[0]
          : entries.find((e) => e.name === name || e.name === `${name}.tar.gz` || e.created === name);
      if (!chosen) {
        fail(
          entries.length === 0
            ? `${config.service} has no backups on ${config.server}.`
            : `No backup "${name}" — \`nodeploy backup list\` shows them (or use "latest").`,
        );
        process.exitCode = 1;
        return;
      }

      info(`Restore ${config.service} on ${config.server} from:`);
      info(`  ${chosen.name} (${chosen.reason}, ${chosen.created}, ${formatBytes(chosen.bytes)})`);
      info(`This replaces ${config.backup.paths.join(", ")} in ${config.deployPath} and stops the app while it does.`);
      info("The current data is backed up first, so this restore can itself be undone.");
      if (!options.yes) {
        const confirmed = await confirmByTyping("", config.service);
        if (!confirmed) {
          fail(process.stdin.isTTY ? "Not confirmed — nothing was changed" : "Refusing to restore without confirmation — pass --yes to run non-interactively");
          process.exitCode = 1;
          return;
        }
      }

      info("  Backing up the current data first...");
      const safety = await backupNow(config, target, "pre-restore");
      if (!reportBackup(safety, "  ")) {
        fail("Not restoring without a backup of the current data.");
        process.exitCode = 1;
        return;
      }

      // Static apps have no process to stop; anything else PM2 runs is
      // stopped so nothing writes to the files while they're replaced.
      const pm2 = createPM2Adapter(target);
      const running = (await pm2.list().catch(() => [])).some(
        (p) => p.name === config.service && p.status === "online",
      );
      if (running) {
        info(`  Stopping ${config.service}...`);
        await pm2.stop(config.service);
      }

      const result = await restoreArchive(target, config.deployPath, chosen.path);

      if (running) {
        info(`  Starting ${config.service}...`);
        await pm2.restart(config.service);
      }

      if (result.error) {
        fail(`Restore failed: ${result.error}`);
        if (result.restored.length > 0) {
          warn(`  Already restored before the failure: ${result.restored.join(", ")}. The data from before this restore is in ${safety.archive}.`);
        }
        process.exitCode = 1;
        return;
      }
      for (const p of result.skipped) warn(`  ${p} wasn't in that backup — left as it is`);
      success(`Restored ${result.restored.join(", ")} from ${chosen.name}${running ? ` and restarted ${config.service}` : ""}`);
      info(`To undo: nodeploy backup restore ${safety.archive!.split("/").pop()}`);
    });
}
