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
- Key-based SSH access from your machine to the target server (`ssh user@server` should work without a password prompt).
- Passwordless `sudo` for the SSH user is only needed for `git`/`nginx` install (via `apt`) and registering PM2 to start on boot (`pm2 startup`). Node.js and PM2 itself install into the user's home directory via [nvm](https://github.com/nvm-sh/nvm) and don't need `sudo` at all — if your account can't get passwordless sudo (e.g. a restricted SSH tunnel user), `setup` still gets the app running, it just warns and skips the sudo-only steps.
- The server needs outbound access to your git remote to clone/pull the repo (e.g. via a deploy key for private repos).

Run `nodeploy doctor` to check all of the above.

### Getting passwordless sudo (or avoiding the need for it)

SSH key auth and `sudo` are unrelated: the key only proves who you are logging in as, and `sudo` is a separate authorization check (via `/etc/sudoers`) that has no idea how you authenticated. There's no way to make a key grant sudo rights on its own — one of the following has to be true on the server first. This is the same constraint [Kamal](https://kamal-deploy.org/) has; it just requires you to set it up first rather than warning about it.

Pick one, from a session that already has root/sudo access (console access, your VPS provider's web terminal, or an existing admin account — not the restricted user itself, since it can't grant itself sudo):

**Option 1 — deploy as `root`.** Simplest, and what Kamal defaults to on providers where the initial VPS user is root. Enable key-only root login in `/etc/ssh/sshd_config`:

```
PermitRootLogin prohibit-password
```

then `sudo systemctl restart sshd`, and add your public key to `/root/.ssh/authorized_keys`. Set `ssh.user: root` in `nodeploy.yml`. No `sudo` prefix is needed at all in this case.

**Option 2 — grant the existing user passwordless sudo.** Keeps a non-root account. Scope it to just what `setup` needs (adjust paths with `which apt-get`/`which systemctl`):

```sh
echo 'youruser ALL=(ALL) NOPASSWD: /usr/bin/apt-get, /usr/sbin/pm2, /bin/systemctl' | sudo EDITOR='tee -a' visudo -f /etc/sudoers.d/youruser
sudo chmod 440 /etc/sudoers.d/youruser
```

**If you can't do either** — e.g. a shared/restricted account behind a tunnel — `setup` still works. Node.js and PM2 install via nvm/npm without sudo, and the sudo-only steps (`git`/`nginx` install, `pm2 startup`) just warn and get skipped; see [What `nodeploy setup` does](#what-nodeploy-setup-does) for what you lose in that case.

### Setting up a deploy key for a private repo

`nodeploy deploy` clones/pulls `repo` *from the server*, not from your machine — so it's the server's SSH identity that needs access to the repo, not yours. If you see `Host key verification failed` or `Permission denied (publickey)` during the sync step, the server either doesn't trust GitHub's host key yet or has no key registered with it. Fix both from a shell on the server itself:

```sh
# 1. Trust GitHub's host key (first-ever SSH connection to github.com from this server)
mkdir -p ~/.ssh && chmod 700 ~/.ssh
ssh-keyscan -H github.com >> ~/.ssh/known_hosts

# 2. Generate a dedicated deploy keypair (don't reuse the key you use to SSH into the server)
ssh-keygen -t ed25519 -C "<service>-deploy-key" -f ~/.ssh/<service>_deploy_key -N ""
cat ~/.ssh/<service>_deploy_key.pub
```

Add the printed public key as a **Deploy key** on the GitHub repo (Settings → Deploy keys → Add deploy key) — read-only access is enough since `nodeploy` only clones/pulls. Then point the server's SSH at it, since `git@github.com` otherwise only tries default keys like `~/.ssh/id_*`:

```sh
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/<service>_deploy_key
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
```

Verify with `ssh -T git@github.com` from the server — it should greet you with the repo name instead of erroring. Once that works, `nodeploy deploy` will be able to clone/pull.

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

# node_version: 22                            # optional, default "22" — nvm version/alias
                                              # `nodeploy setup` installs if node is missing

# start_args:                                 # optional — extra flags appended to the
#   - --host                                  # detected start/preview script, e.g. to bind
                                              # a vite `preview` server to all interfaces

# start_script: start:lan                     # optional — overrides which package.json
                                              # script nodeploy runs under PM2, when
                                              # auto-detection would pick the wrong one

# port and proxy are optional — set both together to front the app with nginx
# port: 3001
# proxy:
#   host: inventory-api.internal
```

`service`, `repo`, `server`, and `ssh.user` are required. `port` is required when `proxy` is set on a Node process app (`nestjs`/`nextjs`/`remix`/`express`/`generic`). Static apps (`vite`/`cra`) don't use `port` at all — they're served straight from disk by nginx — but still need `proxy.host` set, since that's the only way to reach a static app (there's no PM2 process, so there's no `<ip>:<port>` fallback for them).

`proxy.host` can be anything — it's just the nginx `server_name`, resolved via a manual `/etc/hosts` entry (see below) or real DNS if the server has a public IP and domain. A natural pattern when running several apps on one server is `<app-name>.<hostname>`, e.g. `my-app.beepl-office-server-2`, or a shorter fake-TLD like `my-app.internal`/`my-app.lan`. **Avoid `.local`** — it's reserved for mDNS/Bonjour (RFC 6762), and macOS/Linux (avahi) will try multicast DNS resolution for that suffix first, which can make lookups slow or flaky, or ignore your `/etc/hosts` entry depending on `nsswitch.conf` ordering.

### Overriding the detected start script

Auto-detection resolves a start command purely from `package.json`'s `scripts`/`dependencies` shape (see [Supported app types](#supported-app-types-auto-detected)), which can pick the wrong script for apps that weren't built with a server-first `package.json`. Two common cases:

- A `start` script meant for local/desktop use (e.g. `electron .`, or a script with no `HOST`/`0.0.0.0` binding), with a separate script meant for network access — often named `start:lan` or similar in ad-hoc Node servers.
- A plain `node server.js`-style app with no framework dependency, which nodeploy detects as `generic` and correctly runs `start` — but if that project also has a differently-named LAN-facing variant, `start` may still be the wrong one to run unattended on a VPS.

Set `start_script` in `nodeploy.yml` to force a specific script name; nodeploy still runs `build` first if one exists, but starts (and keeps running under PM2) whatever script you name instead of the auto-detected one. This intentionally doesn't change app-type *detection* — it only overrides which script gets executed.

### Reaching the app after deploy

`nodeploy deploy` prints exactly how to reach the app, right after it finishes:

- If `proxy` is set, it prints a `curl -H "Host: <proxy.host>" http://<server>/` command that works immediately — nginx routes on the `Host` header, not DNS, so this verifies the deploy without touching anything on your machine.
- It also prints the `/etc/hosts` line to add for normal browser access (see below) — do that once per machine that needs to reach the app via the hostname.
- If there's no `proxy` (a plain PM2 app with `port` set), it prints the direct `http://<server-ip>:<port>` URL instead — no hosts/DNS setup needed at all in that case.

```sh
# macOS/Linux (needs sudo to edit /etc/hosts)
echo "<server-ip> inventory-api.internal" | sudo tee -a /etc/hosts

# Windows (run as Administrator, edit with a text editor)
# C:\Windows\System32\drivers\etc\hosts
#   <server-ip> inventory-api.internal
```

Then visit `http://inventory-api.internal` (no port needed — nginx listens on 80 and either proxies to the app or, for static `vite`/`cra` apps, serves the build output directly). If the entry is ever wrong or stale, edit/remove that line — nodeploy never manages `/etc/hosts` for you.

## Supported app types (auto-detected)

Detection reads the remote `package.json`'s scripts and dependencies — no configuration needed.

| Type | Scripts required | Dependency marker | Runtime |
|---|---|---|---|
| NestJS | `build` + `start:prod` | `@nestjs/core` | PM2 |
| Next.js | `build` + `start` | `next` | PM2 |
| Remix | `build` + `start` | `@remix-run/serve`, `@remix-run/node`, or `@remix-run/react` | PM2 |
| Vite | `build` + `preview` | `vite` | **static** (nginx serves `dist/` directly) |
| Create React App | `build` + `serve` | `react-scripts` (or `react`) | **static** (nginx serves `build/` directly) |
| Express | `start` only, no `build` | `express` | PM2 |
| generic | anything else | — (runs `build` if present, then the first of `start`/`start:prod`/`serve`/`preview` that exists) | PM2 |

Vite and CRA produce a plain static bundle with no server process of their own — `vite preview`/`serve` are dev-only tools, not meant for production (Vite's own docs say so directly), so `nodeploy deploy` skips PM2 entirely for these two types and instead points nginx's `root` at the build output directory. This means `proxy.host` is **required** for these types (there's nothing else serving the app), but `port` is not used. NestJS/Next.js/Remix/Express/generic apps all run a real Node server process and stay on PM2, which is what gives them restart-on-crash, restart-on-reboot (`pm2 startup`/`pm2 save`), and `logs`/`status`.

Because there's no PM2 process for a static app, `restart`/`stop`/`logs` don't apply to it — `restart`/`deploy` again to republish, remove the nginx site config manually to take it down, and check nginx's own `/var/log/nginx/access.log`/`error.log` for logs. `nodeploy status` still works, checking for an enabled nginx site when there's no matching PM2 process.

Package manager (`npm` vs `pnpm`) is chosen automatically based on whether the app has a `pnpm-lock.yaml` on the server.

## What `nodeploy setup` does

Run once per app per server, before the first deploy (safe to re-run — every step checks first and skips if already satisfied):

1. Checks the SSH connection to `server`.
2. Installs `git` via `apt` if missing. **Requires passwordless sudo** — if unavailable, warns and continues (install `git` manually, then re-run `setup`).
3. Installs [nvm](https://github.com/nvm-sh/nvm) (if needed) and Node.js via `nvm install <node_version>` (default `22`) if `node` isn't already on the server's `PATH`. This installs into the SSH user's home directory — **no sudo required**.
4. Installs PM2 globally via `npm install -g pm2` if missing (also no sudo — nvm's npm installs into the nvm-managed Node's own directory), then tries to register it with `pm2 startup systemd` so PM2-managed apps survive a server reboot. **The `pm2 startup` step requires passwordless sudo**; if unavailable, warns and continues — the app still runs, it just won't come back automatically after a reboot until you fix sudo access and re-run `setup`.
5. If `proxy` is configured in `nodeploy.yml`, installs and starts `nginx` via `apt`. **Requires passwordless sudo**; warns and continues if unavailable.
6. Creates `deploy_path` if it doesn't exist yet.

This targets Ubuntu/Debian (`apt`, `systemd`) — tested against Ubuntu LTS. Other distros aren't supported by `setup` yet; install prerequisites manually and `nodeploy doctor`/`deploy` will still work.

## What `nodeploy deploy` does

Run every time you ship a change (after `setup` has run at least once):

1. Checks the SSH connection to `server`.
2. Clones the repo into `deploy_path` if it isn't there yet, otherwise fetches and hard-resets to `origin/<branch>`.
3. Reads the remote `package.json` to detect the app type and resolve install/build/start commands.
4. Installs dependencies and runs the build step (if any) on the server.
5. For static app types (`vite`/`cra`), points nginx directly at the build output directory instead of starting anything under PM2 — no `port` involved. For every other type, starts (or restarts, if already running) the app under PM2 as `service` (appending `start_args`, if set, to the start/preview script), then `pm2 save`s the process list so it's restored on reboot.
6. If `proxy` is configured (Node process apps only — static apps always write their nginx config in step 5), writes an nginx server block proxying `proxy.host` to `port`, symlinks it into `sites-enabled`, and reloads nginx.

## Architecture

- `src/lib/ssh.ts` — the seam everything else is built on: shells out to the system `ssh` binary via `execa` to run a remote command or test connectivity.
- `src/lib/remoteEnv.ts` — wraps remote commands to source nvm first, so `node`/`npm`/`pm2` resolve in a non-login SSH shell.
- `src/lib/serverSetup.ts` — idempotent provisioning steps (git/nginx via apt, Node via nvm, PM2 via npm, PM2 boot startup, deploy path creation) used by `nodeploy setup`.
- `src/lib/git.ts` — clones or fetches+resets the app's repo on the server over SSH.
- `src/lib/nginx.ts` — generates an nginx server block (reverse-proxy for PM2 apps, or static-file `root` for `vite`/`cra`) and pipes it to the server via SSH (`sites-available` → `sites-enabled` → `nginx -t` → reload).
- `src/lib/deployConfig.ts` — loads and validates `nodeploy.yml` (YAML via the `yaml` package), applying defaults for `branch`/`deploy_path`/`ssh.port`/`node_version`.
- `src/lib/detector.ts` — pluggable, ordered rule list for app-type detection from a `package.json`, plus `resolveStaticDir` mapping static-output app types (`vite`/`cra`) to their build directory. Adding a new framework means adding a rule here.
- `src/lib/pm2.ts` — all process management goes through the `PM2Adapter` interface; `SSHPM2Adapter` runs `pm2` subcommands on the server via `sshExec`.
- `src/lib/doctorChecks.ts` — individual environment health checks, run against the remote server over SSH.

Out of scope for this phase (left as clean extension points, not built): Docker, env/secrets injection, multi-server roles or accessories (databases, etc.), HTTPS/SSL termination, automatic DNS/hosts-file management, non-Debian/Ubuntu `setup` support, and a rollback command.

## Testing

```sh
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
```

Unit-tested with mocked `execa` calls: app-type detection, package manager detection, `nodeploy.yml` loading/validation, SSH argument building, the git clone/pull command, the nginx server-block template and remote deploy command, the PM2 adapter (argument shapes, status mapping, mocked success/failure), server provisioning steps (git/nvm-Node/PM2/nginx install checks), and doctor checks.

**Not unit tested** (requires a real server): actual `apt`/nvm/PM2 installs, `pm2 start` process lifecycle, real `git`/`npm`/`pnpm install`/build execution, nginx reload behavior, and full command flows end-to-end. Verify these manually against a toy app and a real VPS:

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

The first `pm2` command ever run on a server also prints `[PM2] Spawning PM2 daemon...`/`[PM2] PM2 Successfully daemonized` banner lines to stdout before spawning the daemon. `nodeploy` strips these when parsing `pm2 jlist` output (`src/lib/pm2.ts`), so this is handled automatically — mentioned here only in case you see those lines while debugging raw `pm2` output on the server yourself.
