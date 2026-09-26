import type { Command } from "commander";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import {
  loadDeployConfig,
  toEdgeSSHTarget,
  toSSHTarget,
} from "../lib/deployConfig.js";
import { removeCloudflareCredentials } from "../lib/cloudflare.js";
import { clearDeployState } from "../lib/deployState.js";
import { removeEdgeRoute } from "../lib/edge.js";
import { fail, info, success, warn } from "../lib/logger.js";
import { createPM2Adapter } from "../lib/pm2.js";
import { confirmByTyping } from "../lib/prompt.js";
import {
  deleteCertificate,
  removeAppSite,
  removeDeployKey,
  removeDeployPath,
} from "../lib/remove.js";

interface RemoveOptions {
  purge?: boolean;
  yes?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerRemoveCommand(program: Command): void {
  program
    .command("remove")
    .description(
      "Take the app in the current directory off its server: edge routes, nginx site, and PM2 process",
    )
    .option(
      "--purge",
      "also delete the deploy directory, TLS certificate, and deploy key",
      false,
    )
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action(async (options: RemoveOptions) => {
      const config = loadDeployConfig(process.cwd(), DEPLOY_CONFIG_FILENAME);
      const target = toSSHTarget(config);
      const edge = config.proxy?.edge;

      const scope = [
        edge && `its routes on edge ${edge.server}`,
        config.proxy && `its nginx site`,
        "its PM2 process",
        options.purge &&
          `${config.deployPath}${config.proxy?.ssl ? ", its TLS certificate," : ""} and its deploy key`,
      ]
        .filter(Boolean)
        .join(", ");

      if (!options.yes) {
        const confirmed = await confirmByTyping(
          `This removes ${config.service} from ${config.server}: ${scope}.`,
          config.service,
        );
        if (!confirmed) {
          fail(
            process.stdin.isTTY
              ? "Not confirmed — nothing was removed"
              : "Refusing to remove without confirmation — pass --yes to run non-interactively",
          );
          process.exitCode = 1;
          return;
        }
      }

      info(`Removing ${config.service} from ${config.server}...`);

      // Each step is independent: keep going past a failure so one
      // unreachable box doesn't leave everything else in place, and
      // re-running finishes whatever's left (every step is idempotent).
      let failed = false;
      const step = async (label: string, run: () => Promise<string>) => {
        info(`  ${label}...`);
        try {
          success(`  ${await run()}`);
        } catch (error) {
          warn(`  ${label} failed: ${errorMessage(error)}`);
          failed = true;
        }
      };

      // First, so an interrupted remove can't leave a record that makes the
      // next `deploy` think the app is already up to date.
      await step("Clearing deploy record", async () => {
        await clearDeployState(target, config.deployPath);
        return "Next `nodeploy deploy` will deploy in full";
      });

      // Public traffic first, so nothing reaches a half-removed app.
      if (config.proxy && edge) {
        const { host } = config.proxy;
        await step(`Removing routes for ${host} on edge ${edge.server}`, async () => {
          await removeEdgeRoute(toEdgeSSHTarget(edge), host);
          return `Edge ${edge.server} no longer routes ${host}`;
        });
      }

      if (config.proxy) {
        const { host } = config.proxy;
        await step("Removing nginx site", async () => {
          await removeAppSite(target, config.service, host);
          return `nginx no longer serves ${host}`;
        });
      }

      await step("Removing PM2 process", async () => {
        const pm2 = createPM2Adapter(target);
        const processes = await pm2.list();
        if (!processes.some((p) => p.name === config.service)) {
          return `No PM2 process named ${config.service}`;
        }
        await pm2.delete(config.service);
        await pm2.save();
        return `PM2 process ${config.service} deleted`;
      });

      if (options.purge) {
        await step(`Deleting ${config.deployPath}`, async () => {
          await removeDeployPath(target, config.deployPath);
          return `${config.deployPath} deleted`;
        });

        if (config.proxy?.ssl) {
          const { host, ssl } = config.proxy;
          await step(`Deleting TLS certificate for ${host}`, async () =>
            (await deleteCertificate(target, host))
              ? `Certificate for ${host} deleted`
              : `No certificate for ${host}`,
          );
          if (ssl.dns === "cloudflare") {
            await step(`Deleting Cloudflare API token for ${host}`, async () => {
              await removeCloudflareCredentials(target, host);
              return `Cloudflare API token for ${host} deleted from the server — revoke it in Cloudflare too if nothing else uses it`;
            });
          }
        }

        await step("Deleting deploy key", async () => {
          await removeDeployKey(target, config.service);
          return `Deploy key for ${config.service} deleted — also remove it from the repo's Deploy keys`;
        });
      }

      if (failed) {
        fail(
          `${config.service} was only partly removed — fix the errors above and re-run \`nodeploy remove\` to finish`,
        );
        process.exitCode = 1;
        return;
      }

      success(`${config.service} removed from ${config.server}`);
      if (!options.purge) {
        info(
          `Kept ${config.deployPath}${config.proxy?.ssl ? ", the TLS certificate," : ""} and the deploy key — \`nodeploy deploy\` brings it back, or re-run with --purge to delete them too`,
        );
      }
    });
}
