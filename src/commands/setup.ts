import type { Command } from "commander";
import { CLOUDFLARE_TOKEN_ENV, DEPLOY_CONFIG_FILENAME } from "../constants.js";
import {
  ensureCertbotDnsCloudflare,
  hasCloudflareCredentials,
  writeCloudflareCredentials,
} from "../lib/cloudflare.js";
import {
  loadDeployConfig,
  toEdgeSSHTarget,
  toSSHTarget,
} from "../lib/deployConfig.js";
import { bootstrapEdge } from "../lib/edge.js";
import { ensureDeployKey, parseGitSSHHost } from "../lib/deployKey.js";
import { fail, info, success, warn } from "../lib/logger.js";
import {
  ensureCertbot,
  ensureDeployPath,
  ensureGit,
  ensureNginx,
  ensureNginxStreamModule,
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
      "Provision the server for this app once: git, Node.js, PM2, Python (if runtime: python), nginx (if proxy is configured), certbot (if proxy.ssl is set), the edge proxy (if proxy.edge is set), and a deploy key",
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

      // External apps are run by another tool: nodeploy only needs nginx
      // (and certbot/the edge) on the server, not git, Node.js, or PM2.
      const managesApp = config.runtime !== "external";

      if (managesApp) {
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

        if (config.proxy.ssl) {
          info("  Checking certbot...");
          try {
            (await ensureCertbot(target))
              ? success("  certbot installed")
              : success("  certbot already present");
          } catch (error) {
            warn(
              `  Could not install certbot — requires passwordless sudo. \`proxy.ssl\` won't work until this is fixed. (${errorMessage(error)})`,
            );
          }

          if (config.proxy.ssl.dns === "cloudflare") {
            const { host } = config.proxy;
            info("  Checking certbot's Cloudflare DNS plugin...");
            try {
              (await ensureCertbotDnsCloudflare(target))
                ? success("  certbot Cloudflare DNS plugin installed")
                : success("  certbot Cloudflare DNS plugin already present");
            } catch (error) {
              warn(
                `  Could not install python3-certbot-dns-cloudflare — requires passwordless sudo. (${errorMessage(error)})`,
              );
            }

            const token = process.env[CLOUDFLARE_TOKEN_ENV];
            if (token) {
              await writeCloudflareCredentials(target, host, token.trim());
              success(
                `  Cloudflare API token for ${host} stored on the server (root-only)`,
              );
            } else if (await hasCloudflareCredentials(target, host)) {
              info(
                `  Cloudflare API token for ${host} already on the server — set ${CLOUDFLARE_TOKEN_ENV} and re-run setup to replace it`,
              );
            } else {
              warn(
                `  No Cloudflare API token on the server for ${host} — create one with Zone → DNS → Edit on its zone, then re-run setup with ${CLOUDFLARE_TOKEN_ENV} set. \`deploy\` can't issue the certificate until then.`,
              );
            }
          }
        }

        const edge = config.proxy.edge;
        if (edge) {
          const edgeTarget = toEdgeSSHTarget(edge);
          info(`  Checking edge proxy ${edge.server}...`);
          if (!(await sshTest(edgeTarget))) {
            warn(
              `  Could not connect to edge ${edge.ssh.user}@${edge.server} — ${config.proxy.host} won't be reachable through it until this is fixed.`,
            );
          } else {
            try {
              (await ensureNginx(edgeTarget))
                ? success("  nginx installed on edge")
                : success("  nginx already present on edge");

              // Plain-HTTP forwarding needs nothing beyond nginx; the SNI
              // router on 443 is only set up once an app actually needs it.
              if (config.proxy.ssl) {
                if (await ensureNginxStreamModule(edgeTarget)) {
                  success("  nginx stream module installed on edge");
                }
                const moved = await bootstrapEdge(edgeTarget);
                success("  Edge set up to route HTTPS by hostname (SNI)");
                for (const host of moved) {
                  info(
                    `  Moved ${host} (already on the edge) off 443 to the local TLS port, routed via SNI`,
                  );
                }
              }
            } catch (error) {
              warn(
                `  Could not set up edge ${edge.server}. (${errorMessage(error)})`,
              );
            }
          }
        }
      }

      if (managesApp) {
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
      }

      success(`${config.server} is ready for ${config.service}`);
      info(
        managesApp
          ? "Run `nodeploy deploy` to ship the app."
          : "Run `nodeploy deploy` to put nginx in front of the app.",
      );
    });
}
