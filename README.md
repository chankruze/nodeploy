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

- Key-based SSH access from your machine to the target server (`ssh user@server` should work without a password prompt).
- `git`, `node`, and `pm2` installed on the server, and the server able to reach your git remote (e.g. via a deploy key) to clone/pull the repo.
- If you use `proxy`, `nginx` installed on the server and passwordless `sudo` for the SSH user (writing to `/etc/nginx/sites-available` and reloading the service both need it).

Run `nodeploy doctor` to check all of the above.

## Quick start

Add a `nodeploy.yml` to the root of the app's repo (one config per app, checked in like a Kamal `config/deploy.yml`), then run every command from that directory:

```sh
nodeploy init        # scaffold nodeploy.yml in the current directory
# edit nodeploy.yml: service, repo, server, ssh.user, and optionally proxy

nodeploy doctor       # verify SSH + server prerequisites
nodeploy deploy       # clone/pull, install, build, pm2-start on the server
nodeploy status       # show the PM2 status of the deployed service
nodeploy logs         # stream PM2 logs
nodeploy restart
nodeploy stop
```

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

## What `nodeploy deploy` does

1. Checks the SSH connection to `server`.
2. Clones the repo into `deploy_path` if it isn't there yet, otherwise fetches and hard-resets to `origin/<branch>`.
3. Reads the remote `package.json` to detect the app type and resolve install/build/start commands.
4. Installs dependencies and runs the build step (if any) on the server.
5. Starts (or restarts, if already running) the app under PM2 as `service`.
6. If `proxy` is configured, writes an nginx server block proxying `proxy.host` to `port`, symlinks it into `sites-enabled`, and reloads nginx.

## Architecture

- `src/lib/ssh.ts` — the seam everything else is built on: shells out to the system `ssh` binary via `execa` to run a remote command or test connectivity.
- `src/lib/git.ts` — clones or fetches+resets the app's repo on the server over SSH.
- `src/lib/nginx.ts` — generates an nginx server block and pipes it to the server via SSH (`sites-available` → `sites-enabled` → `nginx -t` → reload).
- `src/lib/deployConfig.ts` — loads and validates `nodeploy.yml` (YAML via the `yaml` package), applying defaults for `branch`/`deploy_path`/`ssh.port`.
- `src/lib/detector.ts` — pluggable, ordered rule list for app-type detection from a `package.json`. Adding a new framework means adding a rule here.
- `src/lib/pm2.ts` — all process management goes through the `PM2Adapter` interface; `SSHPM2Adapter` runs `pm2` subcommands on the server via `sshExec`.
- `src/lib/doctorChecks.ts` — individual environment health checks, run against the remote server over SSH.

Out of scope for this phase (left as clean extension points, not built): Docker, env/secrets injection, multi-server roles or accessories (databases, etc.), HTTPS/SSL termination, automatic DNS/hosts-file management, and a rollback command.

## Testing

```sh
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
```

Unit-tested with mocked `execa` calls: app-type detection, package manager detection, `nodeploy.yml` loading/validation, SSH argument building, the git clone/pull command, the nginx server-block template and remote deploy command, the PM2 adapter (argument shapes, status mapping, mocked success/failure), and doctor checks.

**Not unit tested** (requires a real server): actual `pm2 start` process lifecycle, real `git`/`npm`/`pnpm install`/build execution, nginx reload behavior, and full command flows end-to-end. Verify these manually against a toy app and a real VPS:

```sh
cd my-test-app
nodeploy init          # fill in service/repo/server/ssh
nodeploy doctor        # confirm SSH + remote prerequisites
nodeploy deploy
nodeploy status
nodeploy logs
nodeploy restart
nodeploy stop
```

### Known issue: PM2 daemon crash on some machines

On some machines, the PM2 daemon (tested on 5.4.3 and 7.0.3) crashes immediately with `RangeError: Map maximum size exceeded` inside its `pm2-axon` IPC transport, which relies on Node's deprecated `domain` module. This was reproduced identically across Node 18, 22, and 24 on one development machine, ruling out a Node-version incompatibility — it's more likely caused by machine-level process interception (e.g. a corporate security/MDM agent instrumenting every process's socket creation). If `nodeploy doctor` reports PM2 as installed on the server but `deploy`/`status`/`restart`/`stop`/`logs` hang or fail with this error, check `~/.pm2/pm2.log` on the server and investigate what's instrumenting Node processes on that machine — this is an environment issue, not specific to nodeploy.
