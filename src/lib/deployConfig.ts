import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import {
  DEFAULT_BRANCH,
  DEFAULT_NODE_VERSION,
  DEFAULT_RUNTIME,
  DEFAULT_SSH_PORT,
} from "../constants.js";
import type {
  DeployConfig,
  EdgeConfig,
  Runtime,
  SSHConfig,
  SSHTarget,
  SSLConfig,
} from "../types.js";

// `~` only expands via shell tilde-expansion, which doesn't happen when a path
// is interpolated inside a double-quoted string (as every remote command here
// does) — normalize to `$HOME`, which does expand in that context.
function normalizeHomePath(deployPath: string): string {
  if (deployPath === "~") return "$HOME";
  if (deployPath.startsWith("~/")) return `$HOME/${deployPath.slice(2)}`;
  return deployPath;
}

function validateSSHConfig(raw: unknown, key: string): SSHConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`nodeploy.yml: "${key}" must be an object`);
  }

  const sshRaw = raw as Record<string, unknown>;
  if (typeof sshRaw.user !== "string" || sshRaw.user.length === 0) {
    throw new Error(`nodeploy.yml: "${key}.user" must be a non-empty string`);
  }

  if (sshRaw.keys !== undefined) {
    if (
      !Array.isArray(sshRaw.keys) ||
      !sshRaw.keys.every((k) => typeof k === "string")
    ) {
      throw new Error(`nodeploy.yml: "${key}.keys" must be an array of strings`);
    }
  }

  if (sshRaw.port !== undefined && typeof sshRaw.port !== "number") {
    throw new Error(`nodeploy.yml: "${key}.port" must be a number`);
  }

  return {
    user: sshRaw.user,
    keys: sshRaw.keys as string[] | undefined,
    port: (sshRaw.port as number | undefined) ?? DEFAULT_SSH_PORT,
  };
}

function validateEdgeConfig(
  raw: unknown,
  server: string,
  ssh: SSHConfig,
): EdgeConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("nodeploy.yml: \"proxy.edge\" must be an object");
  }

  const edgeRaw = raw as Record<string, unknown>;
  if (typeof edgeRaw.server !== "string" || edgeRaw.server.length === 0) {
    throw new Error(
      "nodeploy.yml: \"proxy.edge.server\" must be a non-empty string",
    );
  }

  if (
    edgeRaw.upstream !== undefined &&
    (typeof edgeRaw.upstream !== "string" || edgeRaw.upstream.length === 0)
  ) {
    throw new Error(
      "nodeploy.yml: \"proxy.edge.upstream\" must be a non-empty string",
    );
  }

  // The edge's port-80 forward would claim proxy.host on the same nginx as
  // the app's own site. Apps on the edge need no `edge` at all: deploy
  // detects the edge's SNI router and routes their HTTPS locally.
  if (edgeRaw.server === server) {
    throw new Error(
      "nodeploy.yml: \"proxy.edge.server\" is the same as \"server\" — apps running on the edge box itself don't need `edge` (nodeploy detects the edge and routes their HTTPS locally); remove it",
    );
  }

  return {
    server: edgeRaw.server,
    ssh:
      edgeRaw.ssh === undefined
        ? ssh
        : validateSSHConfig(edgeRaw.ssh, "proxy.edge.ssh"),
    upstream: (edgeRaw.upstream as string | undefined) ?? server,
  };
}

// Fields that only make sense when nodeploy checks out and runs the app.
const NOT_FOR_EXTERNAL = [
  "repo",
  "branch",
  "deploy_path",
  "node_version",
  "entry",
  "start_args",
  "start_script",
] as const;

export function validateDeployConfig(raw: unknown): DeployConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("nodeploy.yml must be a YAML object");
  }

  const candidate = raw as Record<string, unknown>;

  if (typeof candidate.service !== "string" || candidate.service.length === 0) {
    throw new Error("nodeploy.yml: \"service\" must be a non-empty string");
  }

  const external = candidate.runtime === "external";
  if (external) {
    for (const key of NOT_FOR_EXTERNAL) {
      if (candidate[key] !== undefined) {
        throw new Error(
          `nodeploy.yml: "${key}" doesn't apply to runtime: external — the app is deployed by another tool, nodeploy only fronts it with nginx; remove it`,
        );
      }
    }
  } else if (
    typeof candidate.repo !== "string" ||
    candidate.repo.length === 0
  ) {
    throw new Error("nodeploy.yml: \"repo\" must be a non-empty string");
  }

  if (typeof candidate.server !== "string" || candidate.server.length === 0) {
    throw new Error("nodeploy.yml: \"server\" must be a non-empty string");
  }

  const ssh = validateSSHConfig(candidate.ssh, "ssh");

  if (candidate.branch !== undefined && typeof candidate.branch !== "string") {
    throw new Error("nodeploy.yml: \"branch\" must be a string");
  }

  if (
    candidate.deploy_path !== undefined &&
    typeof candidate.deploy_path !== "string"
  ) {
    throw new Error("nodeploy.yml: \"deploy_path\" must be a string");
  }

  if (candidate.port !== undefined && typeof candidate.port !== "number") {
    throw new Error("nodeploy.yml: \"port\" must be a number");
  }

  if (candidate.start_args !== undefined) {
    if (
      !Array.isArray(candidate.start_args) ||
      !candidate.start_args.every((a) => typeof a === "string")
    ) {
      throw new Error(
        "nodeploy.yml: \"start_args\" must be an array of strings",
      );
    }
  }

  if (
    candidate.start_script !== undefined &&
    (typeof candidate.start_script !== "string" ||
      candidate.start_script.length === 0)
  ) {
    throw new Error(
      "nodeploy.yml: \"start_script\" must be a non-empty string",
    );
  }

  if (
    candidate.node_version !== undefined &&
    typeof candidate.node_version !== "string"
  ) {
    throw new Error("nodeploy.yml: \"node_version\" must be a string");
  }

  let runtime: Runtime = DEFAULT_RUNTIME;
  if (candidate.runtime !== undefined) {
    if (
      candidate.runtime !== "node" &&
      candidate.runtime !== "python" &&
      candidate.runtime !== "external"
    ) {
      throw new Error(
        "nodeploy.yml: \"runtime\" must be \"node\", \"python\", or \"external\"",
      );
    }
    runtime = candidate.runtime;
  }

  if (candidate.entry !== undefined && typeof candidate.entry !== "string") {
    throw new Error("nodeploy.yml: \"entry\" must be a string");
  }

  if (runtime === "python" && typeof candidate.entry !== "string") {
    throw new Error(
      "nodeploy.yml: \"entry\" is required when \"runtime\" is \"python\" (e.g. entry: server.py)",
    );
  }

  let proxy: DeployConfig["proxy"];
  if (candidate.proxy !== undefined) {
    if (typeof candidate.proxy !== "object" || candidate.proxy === null) {
      throw new Error("nodeploy.yml: \"proxy\" must be an object");
    }
    const proxyRaw = candidate.proxy as Record<string, unknown>;
    if (typeof proxyRaw.host !== "string" || proxyRaw.host.length === 0) {
      throw new Error("nodeploy.yml: \"proxy.host\" must be a non-empty string");
    }
    proxy = { host: proxyRaw.host };

    // `ssl: true` is shorthand for `ssl: {}` (no registration email).
    if (proxyRaw.ssl === true) {
      proxy.ssl = {};
    } else if (typeof proxyRaw.ssl === "object" && proxyRaw.ssl !== null) {
      const sslRaw = proxyRaw.ssl as Record<string, unknown>;
      if (
        sslRaw.email !== undefined &&
        (typeof sslRaw.email !== "string" || sslRaw.email.length === 0)
      ) {
        throw new Error(
          "nodeploy.yml: \"proxy.ssl.email\" must be a non-empty string",
        );
      }
      if (sslRaw.dns !== undefined && sslRaw.dns !== "cloudflare") {
        throw new Error(
          "nodeploy.yml: \"proxy.ssl.dns\" must be \"cloudflare\" (the only DNS provider supported so far)",
        );
      }
      proxy.ssl = {
        email: sslRaw.email as string | undefined,
        dns: sslRaw.dns as SSLConfig["dns"],
      };
    } else if (proxyRaw.ssl !== undefined && proxyRaw.ssl !== false) {
      throw new Error(
        "nodeploy.yml: \"proxy.ssl\" must be true, false, or an object (e.g. ssl: { email: you@example.com })",
      );
    }

    if (proxyRaw.edge !== undefined) {
      proxy.edge = validateEdgeConfig(proxyRaw.edge, candidate.server, ssh);
    }
  }

  // Without both there's nothing for nodeploy to do for an external app.
  if (external && (!proxy || typeof candidate.port !== "number")) {
    throw new Error(
      "nodeploy.yml: runtime: external needs \"port\" (where the app listens on the server, e.g. kamal-proxy's http_port) and \"proxy.host\"",
    );
  }

  const config: DeployConfig = {
    service: candidate.service,
    repo: (candidate.repo as string | undefined) ?? "",
    branch: candidate.branch ?? DEFAULT_BRANCH,
    server: candidate.server,
    ssh,
    deployPath: normalizeHomePath(
      (candidate.deploy_path as string | undefined) ??
        `$HOME/apps/${candidate.service}`,
    ),
    nodeVersion:
      (candidate.node_version as string | undefined) ?? DEFAULT_NODE_VERSION,
    runtime,
    entry: candidate.entry as string | undefined,
    port: candidate.port as number | undefined,
    proxy,
    startArgs: candidate.start_args as string[] | undefined,
    startScript: candidate.start_script as string | undefined,
  };

  return config;
}

export function loadDeployConfig(cwd: string, filename: string): DeployConfig {
  const configPath = path.join(cwd, filename);

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No ${filename} found in ${cwd} — run \`nodeploy init\` first`,
    );
  }

  const raw = parse(fs.readFileSync(configPath, "utf-8"));
  return validateDeployConfig(raw);
}

function sshTargetFor(host: string, ssh: SSHConfig): SSHTarget {
  return {
    host,
    user: ssh.user,
    port: ssh.port ?? DEFAULT_SSH_PORT,
    keys: ssh.keys,
  };
}

export function toSSHTarget(config: DeployConfig): SSHTarget {
  return sshTargetFor(config.server, config.ssh);
}

export function toEdgeSSHTarget(edge: EdgeConfig): SSHTarget {
  return sshTargetFor(edge.server, edge.ssh);
}
