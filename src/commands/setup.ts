import type { Command } from "commander";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import { loadDeployConfig, toSSHTarget } from "../lib/deployConfig.js";
import { ensureDeployKey, parseGitSSHHost } from "../lib/deployKey.js";
import { fail, info, success, warn } from "../lib/logger.js";
import {
  ensureDeployPath,
  ensureGit,
  ensureNginx,
  ensureNode,
  ensurePM2,
  ensurePM2Startup,
  ensurePython,
} from "../lib/serverSetup.js";
import { sshTest } from "../lib/ssh.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description(
      "Provision the server for this app once: git, Node.js, PM2, Python (if runtime: python), nginx (if proxy is configured), and a deploy key",
    )
    .action(async () => {
      const config = loadDeployConfig(process.cwd(), DEPLOY_CONFIG_FILENAME);
      const target = toSSHTarget(config);

      info(`Setting up ${config.server} for ${config.service}...`);

      if (!(await sshTest(target))) {
        fail(`Could not connect to ${config.ssh.user}@${config.server}`);
        process.exitCode = 1;
        return;
      }
      success("SSH connection OK");

      info("  Checking git...");
      try {
        (await ensureGit(target))
          ? success("  git installed")
          : success("  git already present");
      } catch (error) {
        warn(
          `  Could not install git — requires passwordless sudo. Install it manually, then re-run setup. (${errorMessage(error)})`,
        );
      }

      info(`  Checking Node.js (nvm, version ${config.nodeVersion})...`);
      await ensureNode(target, config.nodeVersion)
        ? success("  Node.js installed via nvm")
        : success("  Node.js already present");

      info("  Checking PM2...");
      (await ensurePM2(target))
        ? success("  PM2 installed")
        : success("  PM2 already present");

      if (config.runtime === "python") {
        info("  Checking Python (python3, venv)...");
        try {
          (await ensurePython(target))
            ? success("  Python3 + venv installed")
            : success("  Python3 + venv already present");
        } catch (error) {
          warn(
            `  Could not install python3/venv — requires passwordless sudo. Install them manually, then re-run setup. (${errorMessage(error)})`,
          );
        }
      }

      try {
        await ensurePM2Startup(target);
        success("  PM2 set up to start on boot");
      } catch (error) {
        warn(
          `  Could not register PM2 to start on boot — requires passwordless sudo. The app will still run, but won't survive a server reboot until this is fixed. (${errorMessage(error)})`,
        );
      }

      if (config.proxy) {
        info("  Checking nginx...");
        try {
          (await ensureNginx(target))
            ? success("  nginx installed and started")
            : success("  nginx already present");
        } catch (error) {
          warn(
            `  Could not install nginx — requires passwordless sudo. \`proxy\` won't work until this is fixed. (${errorMessage(error)})`,
          );
        }
      }

      const gitHost = parseGitSSHHost(config.repo);
      if (gitHost) {
        info(`  Checking deploy key for ${gitHost}...`);
        const { publicKey, created } = await ensureDeployKey(
          target,
          config.service,
          gitHost,
        );
        if (created) {
          success(`  Generated a new deploy key for ${config.service}`);
        } else {
          info(`  Deploy key for ${config.service} already exists`);
        }
        info(`  Add this as a read-only Deploy key on the repo (Settings → Deploy keys):`);
        info(`  ${publicKey}`);
      }

      info(`  Preparing ${config.deployPath}...`);
      await ensureDeployPath(target, config.deployPath);
      success(`  ${config.deployPath} ready`);

      success(`${config.server} is ready for ${config.service}`);
      info("Run `nodeploy deploy` to ship the app.");
    });
}
