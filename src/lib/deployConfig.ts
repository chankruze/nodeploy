import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { DEFAULT_BRANCH, DEFAULT_NODE_VERSION, DEFAULT_SSH_PORT } from "../constants.js";
import type { DeployConfig, SSHTarget } from "../types.js";

export function validateDeployConfig(raw: unknown): DeployConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("nodeploy.yml must be a YAML object");
  }

  const candidate = raw as Record<string, unknown>;

  if (typeof candidate.service !== "string" || candidate.service.length === 0) {
    throw new Error("nodeploy.yml: \"service\" must be a non-empty string");
  }

  if (typeof candidate.repo !== "string" || candidate.repo.length === 0) {
    throw new Error("nodeploy.yml: \"repo\" must be a non-empty string");
  }

  if (typeof candidate.server !== "string" || candidate.server.length === 0) {
    throw new Error("nodeploy.yml: \"server\" must be a non-empty string");
  }

  if (typeof candidate.ssh !== "object" || candidate.ssh === null) {
    throw new Error("nodeploy.yml: \"ssh\" must be an object");
  }

  const sshRaw = candidate.ssh as Record<string, unknown>;
  if (typeof sshRaw.user !== "string" || sshRaw.user.length === 0) {
    throw new Error("nodeploy.yml: \"ssh.user\" must be a non-empty string");
  }

  if (sshRaw.keys !== undefined) {
    if (
      !Array.isArray(sshRaw.keys) ||
      !sshRaw.keys.every((k) => typeof k === "string")
    ) {
      throw new Error("nodeploy.yml: \"ssh.keys\" must be an array of strings");
    }
  }

  if (sshRaw.port !== undefined && typeof sshRaw.port !== "number") {
    throw new Error("nodeploy.yml: \"ssh.port\" must be a number");
  }

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
    candidate.node_version !== undefined &&
    typeof candidate.node_version !== "string"
  ) {
    throw new Error("nodeploy.yml: \"node_version\" must be a string");
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
  }

  const config: DeployConfig = {
    service: candidate.service,
    repo: candidate.repo,
    branch: candidate.branch ?? DEFAULT_BRANCH,
    server: candidate.server,
    ssh: {
      user: sshRaw.user,
      keys: sshRaw.keys as string[] | undefined,
      port: (sshRaw.port as number | undefined) ?? DEFAULT_SSH_PORT,
    },
    deployPath:
      (candidate.deploy_path as string | undefined) ??
      `~/apps/${candidate.service}`,
    nodeVersion:
      (candidate.node_version as string | undefined) ?? DEFAULT_NODE_VERSION,
    port: candidate.port as number | undefined,
    proxy,
    startArgs: candidate.start_args as string[] | undefined,
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

export function toSSHTarget(config: DeployConfig): SSHTarget {
  return {
    host: config.server,
    user: config.ssh.user,
    port: config.ssh.port ?? DEFAULT_SSH_PORT,
    keys: config.ssh.keys,
  };
}
