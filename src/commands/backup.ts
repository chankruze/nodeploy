import type { Command } from "commander";
import { version } from "../../package.json";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import {
  copyDir,
  ensureCopyAccess,
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
import {
  downloadSetupScript,
  hasNetrcScript,
  linkFunctions,
  mailFunctions,
  netrcScript,
  siteIncludesSnippetScript,
} from "../lib/backupMail.js";
import { shellQuote } from "../lib/logRotation.js";
import { sshExec } from "../lib/ssh.js";
import { NODEPLOY_CREDIT, NODEPLOY_URL, SMTP_PASSWORD_ENV } from "../constants.js";
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

/** Stores the SMTP password on the server when NODEPLOY_SMTP_PASSWORD is
 * set (piped over SSH, never on a command line); otherwise checks one is
 * already there. */
async function setupSmtpPassword(
  email: NonNullable<NonNullable<DeployConfig["backup"]>["email"]>,
  target: SSHTarget,
  quiet?: boolean,
): Promise<void> {
  const { host, user } = email.smtp;
  const password = process.env[SMTP_PASSWORD_ENV];
  try {
    if (password) {
      // The script is the command; the password alone travels on stdin, so
      // it's in no command line or script text.
      await sshExec(target, `sh -c ${shellQuote(netrcScript(host, user))}`, {
        input: `${password.replace(/[\r\n]+$/, "")}\n`,
      });
      if (!quiet) success(`  SMTP password for ${user}@${host} stored on the server (readable only by ${target.user})`);
      return;
    }
    const { stdout } = await sshExec(target, hasNetrcScript(host, user));
    if (stdout.trim() !== "yes") {
      warn(`  No SMTP password on the server for ${user}@${host} — backup emails won't send until you run \`nodeploy backup setup\` with ${SMTP_PASSWORD_ENV} set`);
    }
  } catch (error) {
    warn(`  Could not store the SMTP password: ${(error as Error).message}`);
  }
}

/** One-time nginx setup for download links (needs root or passwordless sudo). */
async function setupDownloads(
  config: DeployConfig & { backup: NonNullable<DeployConfig["backup"]> },
  target: SSHTarget,
  quiet?: boolean,
): Promise<void> {
  const download = config.backup.download!;
  try {
    await sshExec(target, "sh -s", { input: downloadSetupScript(config.service, download) });
    if (!quiet) {
      const where = [
        download.lanPort ? `http://${config.server}:${download.lanPort}` : null,
        download.public && config.proxy ? `https://${config.proxy.host}` : null,
      ].filter(Boolean).join(" and ");
      success(`  Download links set up on ${where}, valid ${download.expiresDays} day(s)`);
    }
    if (download.public) {
      const { stdout } = await sshExec(target, siteIncludesSnippetScript(config.service));
      if (stdout.trim() !== "yes") {
        info(`  Public links start working after the next \`nodeploy deploy\` of ${config.service} (its nginx site needs the downloads include)`);
      }
    }
  } catch (error) {
    const message = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
    warn(`  Download links aren't set up — needs root or passwordless sudo, and nginx. (${message})`);
  }
}

/** Why a remote helper script failed: its own tagged line if it printed
 * one, else SSH's last error line (e.g. a refused key or a timeout). */
function remoteFailure(stdout: string, tag: string, sshError: string): string {
  const own = stdout.split("\n").find((l) => l.startsWith(`${tag}\t`))?.slice(tag.length + 1);
  if (own) return own;
  // "Connection to … closed" / "Connection closed by …" say nothing about why.
  const last = sshError.trim().split("\n").filter((l) => l && !/^Connection (to|closed)\b/.test(l)).pop();
  return last ? `couldn't run it on the server — ${last}` : "unknown error";
}

async function runRemote(target: SSHTarget, input: string): Promise<{ stdout: string; sshError: string }> {
  try {
    const { stdout } = await sshExec(target, "sh -s", { input });
    return { stdout, sshError: "" };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return { stdout: e.stdout ?? "", sshError: e.stderr || e.message || "" };
  }
}

/** `setup`, `deploy`, and `backup setup` install the script and schedule
 * the same way. Returns false if that failed. */
export async function applyBackupSetup(
  config: DeployConfig,
  target: SSHTarget,
  opts: { quiet?: boolean } = {},
): Promise<boolean> {
  if (!config.backup) return true;
  const copy = config.backup.copyTo;
  if (copy) {
    try {
      await ensureCopyAccess(
        target,
        { host: copy.server, user: copy.ssh.user, port: copy.ssh.port ?? 22, keys: copy.ssh.keys },
        copy,
        config.service,
      );
      if (!opts.quiet) {
        success(`  Backups are also copied to ${copy.ssh.user}@${copy.server}:${copyDir(copy, config.service)} (keeping ${copy.keep})`);
      }
    } catch (error) {
      warn(`  Backups won't be copied to ${copy.server} until this is fixed: ${(error as Error).message}`);
    }
  }
  const backupConfig = config as DeployConfig & { backup: NonNullable<DeployConfig["backup"]> };
  if (config.backup.email) await setupSmtpPassword(config.backup.email, target, opts.quiet);
  if (config.backup.download) await setupDownloads(backupConfig, target, opts.quiet);
  try {
    const { cron, warnings } = await setupBackups(target, backupConfig, version);
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
  if (result.copied) success(`${indent}Copied to ${result.copied}`);
  if (result.copyError) warn(`${indent}${result.copyError} — the backup on the app server is fine`);
  if (result.linkError) warn(`${indent}No download link: ${result.linkError}`);
  if (result.mailError) warn(`${indent}The email didn't send: ${result.mailError}`);
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

export { remoteFailure };

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
    .command("link [backup]")
    .description(
      "Make a signed download link for a backup (a name from `backup list`, or \"latest\"), valid for backup.download.expires days",
    )
    .action(async (name: string | undefined) => {
      const app = loadBackupApp();
      if (!app) return;
      const { config, target } = app;
      const download = config.backup.download;
      if (!download) {
        fail("Download links are off — add `download:` to the backup block in nodeploy.yml (e.g. download: { lan_port: 8799 }), then run `nodeploy backup setup`.");
        process.exitCode = 1;
        return;
      }
      const { entries } = await listBackups(target, config.service);
      const chosen = !name || name === "latest" ? entries[0] : entries.find((e) => e.name === name || e.name === `${name}.tar.gz`);
      if (!chosen) {
        fail(entries.length === 0 ? `${config.service} has no backups yet.` : `No backup "${name}" — \`nodeploy backup list\` shows them.`);
        process.exitCode = 1;
        return;
      }
      const { stdout, sshError } = await runRemote(
        target,
        `set -u\n${linkFunctions(config.service, download)}prune_links\nmake_link ${shellQuote(chosen.path)}\n`,
      );
      const line = stdout.split("\n").find((l) => l.startsWith("DOWNLOAD\t"));
      if (!line) {
        fail(`Could not make a link: ${remoteFailure(stdout, "LINK_ERROR", sshError)}`);
        process.exitCode = 1;
        return;
      }
      const [, path, expires] = line.split("\t");
      info(`${chosen.name} (${chosen.reason}, ${chosen.created}, ${formatBytes(chosen.bytes)}):`);
      if (download.lanPort) info(`  On the office network: http://${config.server}:${download.lanPort}${path}`);
      if (download.public && config.proxy) info(`  From anywhere:         https://${config.proxy.host}${path}`);
      info(`Valid until ${new Date(Number(expires) * 1000).toLocaleString()}. Anyone with the link can download the backup until then — share it carefully.`);
    });

  backup
    .command("test-email")
    .description("Send a test email with the backup email settings, to check SMTP works")
    .action(async () => {
      const app = loadBackupApp();
      if (!app) return;
      const { config, target } = app;
      const email = config.backup.email;
      if (!email) {
        fail("Backup emails are off — add `email:` to the backup block in nodeploy.yml, then run `nodeploy backup setup` with NODEPLOY_SMTP_PASSWORD set.");
        process.exitCode = 1;
        return;
      }
      const body = [
        `This is a test email from the nodeploy backups of ${config.service} on ${config.server}.`,
        "",
        `If you got it, backup emails work: a daily one after each scheduled backup${config.backup.download ? " (with a download link)" : ""}, and one whenever a backup fails.`,
        "",
        "—",
        `Sent by nodeploy v${version} (${NODEPLOY_URL}), built by ${NODEPLOY_CREDIT}.`,
      ].join("\n");
      const { stdout, sshError } = await runRemote(
        target,
        `set -u\n${mailFunctions(email)}BODY=$(mktemp)\ncat > "$BODY" <<'NODEPLOY_BODY'\n${body}\nNODEPLOY_BODY\nsend_mail ${shellQuote(`[nodeploy] Test email from ${config.service} on ${config.server}`)} "$BODY"\nrm -f "$BODY"\n`,
      );
      const sent = stdout.split("\n").find((l) => l.startsWith("MAILED\t"));
      if (sent) {
        success(`Test email sent to ${email.to.join(", ")} via ${email.smtp.host}:${email.smtp.port}`);
      } else {
        fail(`Sending failed: ${remoteFailure(stdout, "MAIL_ERROR", sshError)}`);
        process.exitCode = 1;
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
