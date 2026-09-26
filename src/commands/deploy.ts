import type { Command } from "commander";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import { ensureRepo } from "../lib/git.js";
import {
  loadDeployConfig,
  toEdgeSSHTarget,
  toSSHTarget,
} from "../lib/deployConfig.js";
import {
  EDGE_PP_PORT,
  deployEdgeHttpForward,
  edgeSourceAddress,
  prepareEdgeForHttps,
  setEdgeSniRoute,
} from "../lib/edge.js";
import { fail, info, success } from "../lib/logger.js";
import { deployProxyConfig, deployStaticProxyConfig } from "../lib/nginx.js";
import { createPM2Adapter } from "../lib/pm2.js";
import { resolveRemoteApp } from "../lib/remoteApp.js";
import { withNvm } from "../lib/remoteEnv.js";
import { resolveHomePath, sshExec, sshTest } from "../lib/ssh.js";
import type { DeployConfig } from "../types.js";

/** Prints how to reach the app right now, before any local DNS/hosts setup. */
function printAccessInfo(config: DeployConfig): void {
  if (config.proxy?.ssl) {
    info(
      `Verify it's up (bypassing local DNS): curl --resolve ${config.proxy.host}:443:${config.server} https://${config.proxy.host}/`,
    );
    info(`Live at https://${config.proxy.host}`);
    return;
  }

  if (config.proxy) {
    info(
      `Verify it's up right now (no DNS/hosts changes needed): curl -H "Host: ${config.proxy.host}" http://${config.server}/`,
    );
    info(
      `To browse it normally, add "${config.server} ${config.proxy.host}" to your local /etc/hosts, then visit http://${config.proxy.host}`,
    );
    return;
  }

  if (config.port) {
    info(`Reachable directly at http://${config.server}:${config.port}`);
  }
}

/** First half of routing proxy.host through the edge, before the app's own
 * nginx step: the port-80 forward (first-time cert issuance needs ACME
 * challenges to already flow edge → upstream), plus an up-to-date SNI router
 * for HTTPS. Returns the edge's address as this server sees it, which the
 * app's nginx trusts real client IPs from. */
async function prepareEdge(config: DeployConfig): Promise<string | undefined> {
  const edge = config.proxy?.edge;
  if (!config.proxy || !edge) return undefined;

  const edgeTarget = toEdgeSSHTarget(edge);
  info(
    `  Routing ${config.proxy.host} from edge ${edge.server} to ${edge.upstream}...`,
  );
  if (config.proxy.ssl) await prepareEdgeForHttps(edgeTarget);
  await deployEdgeHttpForward(edgeTarget, config.proxy.host, edge.upstream);
  return edgeSourceAddress(edgeTarget, edge.upstream);
}

/** Second half, once the app's nginx has its PROXY-protocol listener: points
 * the edge's HTTPS route at it (or removes the route if SSL is off). */
async function finishEdge(config: DeployConfig): Promise<void> {
  const edge = config.proxy?.edge;
  if (!config.proxy || !edge) return;

  await setEdgeSniRoute(
    toEdgeSSHTarget(edge),
    config.proxy.host,
    config.proxy.ssl ? `${edge.upstream}:${EDGE_PP_PORT}` : null,
  );
}

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
        service: config.service,
      });

      const app = await resolveRemoteApp(target, config);

      const installLabel =
        app.runtime === "python" ? "Setting up venv" : "Installing dependencies";
      info(`  ${installLabel} (${app.installCmd.join(" ")})...`);
      await sshExec(
        target,
        app.runtime === "python"
          ? `cd "${app.dir}" && ${app.installCmd.join(" ")}`
          : withNvm(`cd "${app.dir}" && ${app.installCmd.join(" ")}`),
        { stdio: "inherit" },
      );

      if (app.buildCmd) {
        info(`  Building (${app.packageManager} ${app.buildCmd.join(" ")})...`);
        await sshExec(
          target,
          withNvm(
            `cd "${app.dir}" && ${app.packageManager} ${app.buildCmd.join(" ")}`,
          ),
          { stdio: "inherit" },
        );
      }

      if (app.staticDir) {
        if (!config.proxy) {
          fail(
            `${app.type} apps serve a static build via nginx and need \`proxy.host\` set in ${DEPLOY_CONFIG_FILENAME}`,
          );
          process.exitCode = 1;
          return;
        }

        const root = await resolveHomePath(
          target,
          `${app.dir}/${app.staticDir}`,
        );
        const behindEdge = await prepareEdge(config);
        info(`  Configuring nginx to serve ${root} for ${config.proxy.host}...`);
        await deployStaticProxyConfig(
          target,
          config.service,
          config.proxy.host,
          root,
          config.proxy.ssl,
          behindEdge,
        );
        await finishEdge(config);

        success(`${config.service} deployed`);
        printAccessInfo(config);
        return;
      }

      info("  Starting via PM2...");
      await createPM2Adapter(target).start(app);

      if (config.proxy) {
        if (!config.port) {
          fail(`\`port\` is required in ${DEPLOY_CONFIG_FILENAME} when \`proxy\` is set`);
          process.exitCode = 1;
          return;
        }

        const behindEdge = await prepareEdge(config);
        info(`  Configuring nginx proxy for ${config.proxy.host}...`);
        await deployProxyConfig(
          target,
          config.service,
          config.proxy.host,
          config.port,
          config.proxy.ssl,
          behindEdge,
        );
        await finishEdge(config);
      }

      success(`${config.service} deployed`);
      printAccessInfo(config);
    });
}
