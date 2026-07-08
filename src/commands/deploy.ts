import type { Command } from "commander";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import { ensureRepo } from "../lib/git.js";
import { loadDeployConfig, toSSHTarget } from "../lib/deployConfig.js";
import { fail, info, success } from "../lib/logger.js";
import { deployProxyConfig } from "../lib/nginx.js";
import { createPM2Adapter } from "../lib/pm2.js";
import { resolveRemoteApp } from "../lib/remoteApp.js";
import { sshExec, sshTest } from "../lib/ssh.js";

export function registerDeployCommand(program: Command): void {
  program
    .command("deploy")
    .description("Deploy the app in the current directory to its configured server")
    .action(async () => {
      const config = loadDeployConfig(process.cwd(), DEPLOY_CONFIG_FILENAME);
      const target = toSSHTarget(config);

      info(`Deploying ${config.service} to ${config.server}...`);

      if (!(await sshTest(target))) {
        fail(`Could not connect to ${config.ssh.user}@${config.server}`);
        process.exitCode = 1;
        return;
      }

      info("  Syncing repository...");
      await ensureRepo(target, {
        repo: config.repo,
        branch: config.branch,
        deployPath: config.deployPath,
      });

      const app = await resolveRemoteApp(target, config);

      info(`  Installing dependencies (${app.installCmd.join(" ")})...`);
      await sshExec(
        target,
        `cd "${app.dir}" && ${app.installCmd.join(" ")}`,
        { stdio: "inherit" },
      );

      if (app.buildCmd) {
        info(`  Building (${app.packageManager} ${app.buildCmd.join(" ")})...`);
        await sshExec(
          target,
          `cd "${app.dir}" && ${app.packageManager} ${app.buildCmd.join(" ")}`,
          { stdio: "inherit" },
        );
      }

      info("  Starting via PM2...");
      await createPM2Adapter(target).start(app);

      if (config.proxy && config.port) {
        info(`  Configuring nginx proxy for ${config.proxy.host}...`);
        await deployProxyConfig(
          target,
          config.service,
          config.proxy.host,
          config.port,
        );
      }

      success(`${config.service} deployed`);

      if (config.proxy) {
        info(
          `Add "${config.server} ${config.proxy.host}" to your local /etc/hosts to access it at http://${config.proxy.host}`,
        );
      }
    });
}
