import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { execa } from "execa";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import { loadDeployConfig, toSSHTarget } from "../lib/deployConfig.js";
import { formatBytes } from "../lib/format.js";
import { fail, info, success, warn } from "../lib/logger.js";
import { shellQuote } from "../lib/logRotation.js";
import { inspectServerChanges } from "../lib/serverChanges.js";
import { sshReadFile } from "../lib/ssh.js";

interface PullOptions {
  force?: boolean;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execa("git", args, { cwd });
  return stdout.trim();
}

/** "Sync to git": copies the files changed on the server into this checkout,
 * so they can be committed and pushed. The next deploy then finds the
 * server's copies matching the new commit, and nothing is lost. */
export function registerPullFilesCommand(program: Command): void {
  program
    .command("pull-files")
    .description(
      "Copy files changed on the server (ones `deploy` would reset) into this git checkout, to commit and push them",
    )
    .option("-f, --force", "overwrite local files that have uncommitted changes", false)
    .action(async (options: PullOptions) => {
      const config = loadDeployConfig(process.cwd(), DEPLOY_CONFIG_FILENAME);
      if (config.runtime === "external") {
        fail(`${config.service} is run by another tool (runtime: external) — nodeploy has no checkout of it on the server.`);
        process.exitCode = 1;
        return;
      }
      const target = toSSHTarget(config);

      let root: string;
      try {
        root = await git(["rev-parse", "--show-toplevel"], process.cwd());
      } catch {
        fail("Run this from the app's git checkout — the pulled files are written into it.");
        process.exitCode = 1;
        return;
      }

      const inspected = await inspectServerChanges(target, {
        repo: config.repo,
        branch: config.branch,
        deployPath: config.deployPath,
        service: config.service,
      });
      if (!inspected) {
        info(`${config.service} has no checkout on ${config.server} yet — nothing to pull.`);
        return;
      }

      const toPull = inspected.changes.filter((c) => c.kind !== "same");
      const alreadyInGit = inspected.changes.filter((c) => c.kind === "same");
      for (const c of alreadyInGit) info(`  ${c.path}: already matches ${config.branch} — nothing to pull`);
      if (toPull.length === 0) {
        success(`Nothing on ${config.server} differs from ${config.branch} — \`nodeploy deploy\` won't reset anything.`);
        return;
      }

      const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], root).catch(() => "");
      if (branch && branch !== config.branch) {
        warn(`This checkout is on "${branch}", but ${config.service} deploys "${config.branch}" — commit the pulled files to ${config.branch}.`);
      }

      let pulled = 0;
      for (const change of toPull) {
        const local = path.join(root, change.path);
        const dirty = fs.existsSync(local)
          ? await git(["status", "--porcelain", "--", change.path], root).catch(() => "")
          : "";
        if (dirty && !options.force) {
          warn(`  skipped ${change.path}: it has uncommitted local changes (--force overwrites them)`);
          continue;
        }
        const bytes = await sshReadFile(
          target,
          `"${config.deployPath}"/${shellQuote(change.path)}`,
        );
        fs.mkdirSync(path.dirname(local), { recursive: true });
        fs.writeFileSync(local, bytes);
        pulled++;
        success(`  ${change.path} (${formatBytes(bytes.length)})`);
        if (Buffer.from(bytes.subarray(0, 15)).toString() === "SQLite format 3") {
          warn(`    ${change.path} is a live SQLite database — committing it works, but the lasting fix is to stop tracking it (.gitignore + \`git rm --cached\`) and deploy with --keep-server-files`);
        }
      }

      if (pulled > 0) {
        info("");
        info(`Pulled ${pulled} file(s) from ${config.server}. Review them, then commit and push:`);
        info(`  git add ${toPull.map((c) => shellQuote(c.path)).join(" ")} && git commit -m "sync data from ${config.service}" && git push`);
        info("Then `nodeploy deploy` — the server's copies will match the new commit, so nothing is reset.");
      }
    });
}
