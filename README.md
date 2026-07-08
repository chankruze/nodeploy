# nodeploy

A lightweight, self-hosted deployment CLI for shipping a Node.js app to a bare-metal server or VPS over SSH, in the spirit of [Kamal](https://kamal-deploy.org/) but without Docker. Run `nodeploy deploy` from your app's repo and it SSHes in, pulls the latest code, installs/builds it, and (re)starts it under [PM2](https://pm2.keymetrics.io/) — replacing the manual "push, ssh, cd, git pull, restart" loop. An optional nginx reverse proxy lets you reach the app at a hostname instead of `<ip>:<port>`.

## Install

Add nodeploy as a dev dependency of the app you want to deploy, straight from git (not published to a registry yet):

```sh
pnpm add -D git+https://github.com/<you>/nodeploy.git
# or: npm install -D git+https://github.com/<you>/nodeploy.git
```

The `prepare` script runs `tsup` on install, so `dist/cli.js` is built automatically and `nodeploy` is available via `pnpm exec nodeploy` / `npx nodeploy` / your `package.json` scripts.

To work on nodeploy itself instead, clone this repo and build it locally:

```sh
pnpm install
pnpm build
```

The built CLI is at `dist/cli.js` (bin name `nodeploy`). Link it locally with `pnpm link --global`, or run it directly with `node dist/cli.js`.

## Prerequisites

- A fresh Ubuntu LTS server (24.04/26.04) reachable over SSH. `nodeploy setup` provisions everything else below — you don't need to install git/Node/PM2/nginx by hand.
- Key-based SSH access from your machine to the target server (`ssh user@server` should work without a password prompt), and that user must be able to run `sudo` without a password (needed by `setup` to install packages and by the nginx proxy step).
- The server needs outbound access to your git remote to clone/pull the repo (e.g. via a deploy key for private repos).

Run `nodeploy doctor` to check all of the above.

## Quick start

Add a `nodeploy.yml` to the root of the app's repo (one config per app, checked in like a Kamal `config/deploy.yml`), then run every command from that directory:

```sh
nodeploy init        # scaffold nodeploy.yml in the current directory
# edit nodeploy.yml: service, repo, server, ssh.user, and optionally proxy

nodeploy doctor       # verify SSH + server prerequisites
nodeploy setup        # once per app per server: install git/Node/PM2/nginx, prep deploy_path
nodeploy deploy       # clone/pull, install, build, pm2-start on the server — run this every time
nodeploy status       # show the PM2 status of the deployed service
nodeploy logs         # stream PM2 logs
nodeploy restart
nodeploy stop
```

`setup` is idempotent and safe to re-run, but you only need it once per app per server — after that, `deploy` is the day-to-day command.


## `nodeploy.yml`

```yaml
service: inventory-api                       # PM2 process name, nginx server block name

repo: git@github.com:you/inventory-api.git   # cloned/pulled on the server; needs to be
                                              # reachable from there (e.g. via deploy key)
# branch: main                               # optional, default "main"

server: 203.0.113.10                         # the server to deploy to

ssh:
  user: root
  # keys:                                    # optional, default: ssh-agent/default identity
  #   - ~/.ssh/id_ed25519
  # port: 22                                 # optional, default 22

# deploy_path: ~/apps/inventory-api          # optional, default ~/apps/<service>

# node_version: 22                            # optional, default "22" — NodeSource release line
                                              # `nodeploy setup` installs if node is missing

# port and proxy are optional — set both together to front the app with nginx
# port: 3001
# proxy:
#   host: inventory-api.local
```

`service`, `repo`, `server`, and `ssh.user` are required. `port` is required if `proxy` is set.

Since domain resolution for `.local`-style hosts isn't handled by nodeploy, after a deploy with `proxy` configured you'll need to point that hostname at the server yourself — e.g. add `<server-ip> inventory-api.local` to `/etc/hosts` on machines that need to reach it, or use real DNS if the server has a public IP and domain.

## Supported app types (auto-detected)

Detection reads the remote `package.json`'s scripts and dependencies — no configuration needed.

| Type | Scripts required | Dependency marker |
|---|---|---|
| NestJS | `build` + `start:prod` | `@nestjs/core` |
| Next.js | `build` + `start` | `next` |
| Vite | `build` + `preview` | `vite` |
| Create React App | `build` + `serve` | `react-scripts` (or `react`) |
| Express | `start` only, no `build` | none |
| generic | anything else | — (runs `build` if present, then the first of `start`/`start:prod`/`serve`/`preview` that exists) |

Package manager (`npm` vs `pnpm`) is chosen automatically based on whether the app has a `pnpm-lock.yaml` on the server.

## What `nodeploy setup` does

Run once per app per server, before the first deploy (safe to re-run — every step checks first and skips if already satisfied):

1. Checks the SSH connection to `server`.
2. Installs `git` via `apt` if missing.
3. Installs Node.js via the [NodeSource](https://github.com/nodesource/distributions) `node_version` release line (default `22`) if `node` isn't already on the server's `PATH`.
4. Installs PM2 globally (`npm install -g pm2`) if missing, then runs `pm2 startup systemd` so PM2-managed apps survive a server reboot.
5. If `proxy` is configured in `nodeploy.yml`, installs and starts `nginx` via `apt`.
6. Creates `deploy_path` if it doesn't exist yet.

This targets Ubuntu/Debian (`apt`, `systemd`) — tested against Ubuntu LTS. Other distros aren't supported by `setup` yet; install prerequisites manually and `nodeploy doctor`/`deploy` will still work.

## What `nodeploy deploy` does

Run every time you ship a change (after `setup` has run at least once):

1. Checks the SSH connection to `server`.
2. Clones the repo into `deploy_path` if it isn't there yet, otherwise fetches and hard-resets to `origin/<branch>`.
3. Reads the remote `package.json` to detect the app type and resolve install/build/start commands.
4. Installs dependencies and runs the build step (if any) on the server.
5. Starts (or restarts, if already running) the app under PM2 as `service`, then `pm2 save`s the process list so it's restored on reboot.
6. If `proxy` is configured, writes an nginx server block proxying `proxy.host` to `port`, symlinks it into `sites-enabled`, and reloads nginx.

## Architecture

- `src/lib/ssh.ts` — the seam everything else is built on: shells out to the system `ssh` binary via `execa` to run a remote command or test connectivity.
- `src/lib/serverSetup.ts` — idempotent provisioning steps (git/Node/PM2/nginx install, PM2 boot startup, deploy path creation) used by `nodeploy setup`.
- `src/lib/git.ts` — clones or fetches+resets the app's repo on the server over SSH.
- `src/lib/nginx.ts` — generates an nginx server block and pipes it to the server via SSH (`sites-available` → `sites-enabled` → `nginx -t` → reload).
- `src/lib/deployConfig.ts` — loads and validates `nodeploy.yml` (YAML via the `yaml` package), applying defaults for `branch`/`deploy_path`/`ssh.port`/`node_version`.
- `src/lib/detector.ts` — pluggable, ordered rule list for app-type detection from a `package.json`. Adding a new framework means adding a rule here.
- `src/lib/pm2.ts` — all process management goes through the `PM2Adapter` interface; `SSHPM2Adapter` runs `pm2` subcommands on the server via `sshExec`.
- `src/lib/doctorChecks.ts` — individual environment health checks, run against the remote server over SSH.

Out of scope for this phase (left as clean extension points, not built): Docker, env/secrets injection, multi-server roles or accessories (databases, etc.), HTTPS/SSL termination, automatic DNS/hosts-file management, non-Debian/Ubuntu `setup` support, and a rollback command.

## Testing

```sh
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
```

Unit-tested with mocked `execa` calls: app-type detection, package manager detection, `nodeploy.yml` loading/validation, SSH argument building, the git clone/pull command, the nginx server-block template and remote deploy command, the PM2 adapter (argument shapes, status mapping, mocked success/failure), server provisioning steps (git/Node/PM2/nginx install checks), and doctor checks.

**Not unit tested** (requires a real server): actual `apt`/NodeSource/PM2 installs, `pm2 start` process lifecycle, real `git`/`npm`/`pnpm install`/build execution, nginx reload behavior, and full command flows end-to-end. Verify these manually against a toy app and a real VPS:

```sh
cd my-test-app
nodeploy init          # fill in service/repo/server/ssh
nodeploy doctor        # confirm SSH + remote prerequisites
nodeploy setup         # provision git/Node/PM2/nginx once
nodeploy deploy
nodeploy status
nodeploy logs
nodeploy restart
nodeploy stop
```

### Known issue: PM2 daemon crash on some machines

On some machines, the PM2 daemon (tested on 5.4.3 and 7.0.3) crashes immediately with `RangeError: Map maximum size exceeded` inside its `pm2-axon` IPC transport, which relies on Node's deprecated `domain` module. This was reproduced identically across Node 18, 22, and 24 on one development machine, ruling out a Node-version incompatibility — it's more likely caused by machine-level process interception (e.g. a corporate security/MDM agent instrumenting every process's socket creation). If `nodeploy doctor` reports PM2 as installed on the server but `deploy`/`status`/`restart`/`stop`/`logs` hang or fail with this error, check `~/.pm2/pm2.log` on the server and investigate what's instrumenting Node processes on that machine — this is an environment issue, not specific to nodeploy.
