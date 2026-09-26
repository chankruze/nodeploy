import type { Command } from "commander";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import {
  deployFingerprint,
  readDeployState,
  shouldSkipDeploy,
  writeDeployState,
} from "../lib/deployState.js";
import { ensureRepo, remoteBranchHead } from "../lib/git.js";
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
import {
  deployProxyConfig,
  deployStaticProxyConfig,
  isStaticSiteEnabled,
} from "../lib/nginx.js";
import { createPM2Adapter } from "../lib/pm2.js";
import { resolveRemoteApp } from "../lib/remoteApp.js";
import { withNvm } from "../lib/remoteEnv.js";
import { resolveHomePath, sshExec, sshTest } from "../lib/ssh.js";
import type { DeployConfig, SSHTarget } from "../types.js";

interface DeployOptions {
  force?: boolean;
}

/** Whether the app from the last deploy is still being served — a skipped
 * deploy must never leave an app down (e.g. after `nodeploy remove`, which
 * keeps the checkout, or a crashed PM2 process). */
async function isLive(
  target: SSHTarget,
  config: DeployConfig,
  kind: "pm2" | "static",
): Promise<boolean> {
  if (kind === "static") return isStaticSiteEnabled(target, config.service);
  try {
    const processes = await createPM2Adapter(target).list();
    return processes.some(
      (p) => p.name === config.service && p.status === "online",
    );
  } catch {
    return false;
  }
}

/** The commit the checkout is at after syncing — what this deploy actually
 * ships, even if the branch moved on since the skip check. */
async function checkedOutCommit(
  target: SSHTarget,
  deployPath: string,
): Promise<string> {
  const { stdout } = await sshExec(target, `git -C "${deployPath}" rev-parse HEAD`);
  return stdout.trim();
}

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
    .option(
      "-f, --force",
      "deploy even if the server already runs this commit with the same config",
      false,
    )
    .action(async (options: DeployOptions) => {
      const config = loadDeployConfig(process.cwd(), DEPLOY_CONFIG_FILENAME);
      const target = toSSHTarget(config);

      info(`Deploying ${config.service} to ${config.server}...`);

      if (!(await sshTest(target))) {
        fail(`Could not connect to ${config.ssh.user}@${config.server}`);
        process.exitCode = 1;
        return;
      }

      const fingerprint = deployFingerprint(config);
      if (options.force) {
        info("  --force: deploying regardless of what's already on the server");
      } else {
        const decision = await shouldSkipDeploy(
          await readDeployState(target, config.deployPath),
          await remoteBranchHead(target, {
            repo: config.repo,
            branch: config.branch,
            service: config.service,
          }),
          fingerprint,
          (kind) => isLive(target, config, kind),
        );
        if (decision.skip) {
          success(
            `${config.service} is already deployed at ${decision.commit.slice(0, 7)} (${config.branch}) with the same config — nothing to do. Use --force to redeploy anyway.`,
          );
          printAccessInfo(config);
          return;
        }
        info(`  Deploying: ${decision.reason}`);
      }

      info("  Syncing repository...");
      await ensureRepo(target, {
        repo: config.repo,
        branch: config.branch,
        deployPath: config.deployPath,
        service: config.service,
      });
      const commit = await checkedOutCommit(target, config.deployPath);

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

        await writeDeployState(target, config.deployPath, {
          commit,
          fingerprint,
          kind: "static",
        });
        success(`${config.service} deployed at ${commit.slice(0, 7)}`);
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

      await writeDeployState(target, config.deployPath, {
        commit,
        fingerprint,
        kind: "pm2",
      });
      success(`${config.service} deployed at ${commit.slice(0, 7)}`);
      printAccessInfo(config);
    });
}
