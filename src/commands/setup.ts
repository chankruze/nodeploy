import type { Command } from "commander";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import { loadDeployConfig, toSSHTarget } from "../lib/deployConfig.js";
import { fail, info, success } from "../lib/logger.js";
import {
  ensureDeployPath,
  ensureGit,
  ensureNginx,
  ensureNode,
  ensurePM2,
} from "../lib/serverSetup.js";
import { sshTest } from "../lib/ssh.js";

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description(
      "Provision the server for this app once: git, Node.js, PM2, and nginx (if proxy is configured)",
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
      (await ensureGit(target))
        ? success("  git installed")
        : success("  git already present");

      info(`  Checking Node.js (${config.nodeVersion}.x)...`);
      (await ensureNode(target, config.nodeVersion))
        ? success("  Node.js installed")
        : success("  Node.js already present");

      info("  Checking PM2...");
      (await ensurePM2(target))
        ? success("  PM2 installed and set up to start on boot")
        : success("  PM2 already present, boot startup confirmed");

      if (config.proxy) {
        info("  Checking nginx...");
        (await ensureNginx(target))
          ? success("  nginx installed and started")
          : success("  nginx already present");
      }

      info(`  Preparing ${config.deployPath}...`);
      await ensureDeployPath(target, config.deployPath);
      success(`  ${config.deployPath} ready`);

      success(`${config.server} is ready for ${config.service}`);
      info("Run `nodeploy deploy` to ship the app.");
    });
}
