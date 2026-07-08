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

# nvm version/alias to install if node is missing on the server (used by nodeploy setup).
# node_version: 22

# Extra flags appended to the detected start/preview script, e.g. to bind
# the app to all interfaces instead of just localhost.
# start_args:
#   - --host

# Uncomment to front the app with an nginx reverse proxy.
# port: 3000
# proxy:
#   host: my-app.local
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
