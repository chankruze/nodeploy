import type { Command } from "commander";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import {
  loadDeployConfig,
  toEdgeSSHTarget,
  toSSHTarget,
} from "../lib/deployConfig.js";
import {
  EDGE_LOCAL_TLS,
  assertRouteHost,
  assertUpstream,
  deployEdgeRoute,
  ensureEdgeBootstrapped,
  isEdgeBootstrapped,
  listEdgeRoutes,
  removeEdgeRoute,
} from "../lib/edge.js";
import { info, success, warn } from "../lib/logger.js";
import type { SSHTarget } from "../types.js";

interface AddOptions {
  httpOnly?: boolean;
}

/** The edge to manage: this app's proxy.edge, or — for an app running on
 * the edge itself, which has no `edge` block — the app's own server. */
function resolveEdge(): SSHTarget {
  const config = loadDeployConfig(process.cwd(), DEPLOY_CONFIG_FILENAME);
  return config.proxy?.edge
    ? toEdgeSSHTarget(config.proxy.edge)
    : toSSHTarget(config);
}

export function registerEdgeCommand(program: Command): void {
  const edge = program
    .command("edge")
    .description(
      "Manage routes on the edge proxy (this app's proxy.edge, or its own server if it runs on the edge)",
    );

  edge
    .command("list")
    .description("List every hostname the edge routes, and where to")
    .action(async () => {
      const target = resolveEdge();
      const routes = await listEdgeRoutes(target);

      if (routes.length === 0) {
        info(`${target.host} has no nodeploy-managed routes`);
      } else {
        info(`Routes on ${target.host} (exact hosts win over wildcards):`);
        const width = Math.max(...routes.map((r) => r.host.length));
        for (const route of routes) {
          const http = route.http ? `http → ${route.http}` : "http → (none)";
          const https = route.https
            ? `https → ${route.https === EDGE_LOCAL_TLS ? "this box" : route.https}`
            : "https → (none)";
          info(`  ${route.host.padEnd(width)}  ${http.padEnd(24)}  ${https}`);
        }
      }

      if (!(await isEdgeBootstrapped(target))) {
        warn(
          `${target.host} isn't set up for HTTPS routing — \`nodeploy edge add\` or \`nodeploy setup\` (for an ssl app) sets it up`,
        );
      }
    });

  edge
    .command("add <host> <upstream>")
    .description(
      "Route a hostname — or a whole domain, e.g. '*.example.com' — to an upstream server's nginx on 80 and 443",
    )
    .option("--http-only", "route port 80 only, not HTTPS", false)
    .action(async (host: string, upstream: string, options: AddOptions) => {
      assertRouteHost(host);
      assertUpstream(upstream);

      const target = resolveEdge();
      // The port-80 forward would proxy the edge's nginx to itself forever.
      // HTTPS apps on the edge get their route from `deploy` instead.
      if (["127.0.0.1", "localhost", target.host].includes(upstream)) {
        throw new Error(
          `${upstream} is the edge itself — apps running on the edge don't need a route here; \`nodeploy deploy\` sets up their HTTPS routing`,
        );
      }

      const ssl = !options.httpOnly;
      if (ssl) {
        const moved = await ensureEdgeBootstrapped(target);
        for (const movedHost of moved) {
          info(
            `Moved ${movedHost} (already on the edge) off 443 to the local TLS port, routed via SNI`,
          );
        }
      }

      await deployEdgeRoute(target, host, upstream, ssl);
      success(
        `${target.host} now routes ${host} → ${upstream} (${ssl ? "http + https" : "http"})`,
      );
      if (host.startsWith("*.")) {
        info(
          `Hosts with their own route still go to their own upstream. Make sure DNS for ${host} points at the edge's public IP.`,
        );
      }
    });

  edge
    .command("remove <host>")
    .description("Stop routing a hostname (or wildcard) through the edge")
    .action(async (host: string) => {
      assertRouteHost(host);
      const target = resolveEdge();
      await removeEdgeRoute(target, host);
      success(`${target.host} no longer routes ${host}`);
    });
}
