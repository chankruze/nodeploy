import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { DEPLOY_CONFIG_FILENAME } from "../constants.js";
import { info, success } from "../lib/logger.js";

interface InitOptions {
  force?: boolean;
}

const TEMPLATE = `# Name of your app. Used as the PM2 process name and nginx server block name.
service: my-app

# Git repository to clone/pull on the server. Use an SSH URL the server can reach
# (e.g. via a deploy key), such as git@github.com:you/my-app.git
repo: git@github.com:you/my-app.git

# branch: main

# The server to deploy to.
server: 203.0.113.10

ssh:
  user: root
  # keys:
  #   - ~/.ssh/id_ed25519
  # port: 22

# deploy_path: ~/apps/my-app

# runtime: node (default) or python. Python apps run under PM2 in a
# dedicated venv (created even with no dependencies, for isolation).
# runtime: python
# entry: server.py                            # required for runtime: python

# nvm version/alias to install if node is missing on the server (used by nodeploy setup).
# node_version: 22

# Extra flags appended to the detected start/preview script, e.g. to bind
# the app to all interfaces instead of just localhost.
# start_args:
#   - --host

# Overrides which package.json script nodeploy runs under PM2, if auto-detection
# picks the wrong one (e.g. a "start" script that isn't meant for a server).
# start_script: start:lan

# Uncomment to front the app with an nginx reverse proxy.
# port: 3000
# proxy:
#   host: my-app.internal
#   # HTTPS via a per-app Let's Encrypt cert. host must be a real public domain
#   # (e.g. my-app.example.com) whose DNS points at this server, with port 80 open.
#   ssl:
#     email: you@example.com
#     # For a LAN-only server (no public IP or open port 80): prove the domain
#     # via a Cloudflare DNS record instead. Run \`nodeploy setup\` with
#     # CLOUDFLARE_API_TOKEN set (Zone -> DNS -> Edit) — never put it in here.
#     # dns: cloudflare
#   # If the router forwards public 80/443 to a different box (an "edge"),
#   # nodeploy routes this host from there to this server.
#   edge:
#     server: 192.168.0.8
#     # ssh: { user: root }                   # defaults to the ssh block above
#     # upstream: 192.168.0.12                # how the edge reaches this server; defaults to server
`;

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description(`Scaffold a ${DEPLOY_CONFIG_FILENAME} in the current directory`)
    .option("--force", "overwrite an existing config", false)
    .action((options: InitOptions) => {
      const configPath = path.join(process.cwd(), DEPLOY_CONFIG_FILENAME);

      if (fs.existsSync(configPath) && !options.force) {
        info(`${DEPLOY_CONFIG_FILENAME} already exists at ${configPath}`);
        info("Pass --force to overwrite.");
        return;
      }

      fs.writeFileSync(configPath, TEMPLATE);
      success(`Created ${configPath}`);
      info("Fill in service/repo/server/ssh, then run `nodeploy setup` once, then `nodeploy deploy`.");
    });
}
