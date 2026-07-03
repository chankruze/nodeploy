# nodeploy

A lightweight, self-hosted deployment CLI for running multiple Node.js apps behind [PM2](https://pm2.keymetrics.io/) on a single VPS or home server. Point it at a folder of apps and it handles install, build, and process management — no Docker, no dashboard, no ceremony.

## Install

```sh
pnpm install
pnpm build
```

The built CLI is at `dist/cli.js` (bin name `nodeploy`). Link it locally with `pnpm link --global`, or run it directly with `node dist/cli.js`.

## Quick start

```sh
nodeploy init                 # writes ~/.nodeploy/config.json, defaults appsDir to ~/apps
nodeploy list                 # scan appsDir and show detected apps
nodeploy deploy                # install, build, and pm2-start every app
nodeploy deploy my-app          # deploy a single app by name
nodeploy restart my-app
nodeploy stop my-app
nodeploy logs my-app
nodeploy doctor                # check your environment is ready
```

## Folder structure

```
~/apps
  inventory-api/
    package.json
    nodeploy.json      # optional
  admin/
    package.json
```

### `nodeploy.json` (optional, per app)

```json
{
  "name": "inventory-api",
  "port": 3001
}
```

If omitted, the app is identified by its directory name and has no fixed port.

## Supported app types (auto-detected)

Detection reads `package.json` scripts and dependencies — no configuration needed.

| Type | Scripts required | Dependency marker |
|---|---|---|
| NestJS | `build` + `start:prod` | `@nestjs/core` |
| Next.js | `build` + `start` | `next` |
| Vite | `build` + `preview` | `vite` |
| Create React App | `build` + `serve` | `react-scripts` (or `react`) |
| Express | `start` only, no `build` | none |
| generic | anything else | — (runs `build` if present, then the first of `start`/`start:prod`/`serve`/`preview` that exists) |

Package manager (`npm` vs `pnpm`) is chosen automatically based on whether the app has a `pnpm-lock.yaml`.

## Global config

`~/.nodeploy/config.json`:

```json
{
  "appsDir": "/home/user/apps",
  "defaults": {
    "packageManager": "auto"
  }
}
```

Written by `nodeploy init`. Re-running `init` is a no-op unless you pass `--force`.

## Architecture

- `src/lib/detector.ts` — pluggable, ordered rule list for app-type detection. Adding a new framework means adding a rule here.
- `src/lib/pm2.ts` — all process management goes through the `PM2Adapter` interface (`ExecaPM2Adapter` shells out to the `pm2` CLI). This is the seam for future non-PM2 backends (Docker, systemd).
- `src/lib/scanner.ts` — composes `package.json` + optional `nodeploy.json` into `DetectedApp` records used by every command.
- `src/lib/config.ts` / `appConfig.ts` — load/validate the global and per-app config files.
- `src/lib/doctorChecks.ts` — individual environment health checks.

Out of scope for this phase (left as clean extension points, not built): Nginx config generation, HTTPS, a file watcher, a web dashboard, remote push deploy, and multi-runtime support (Python/Go/Docker).

## Testing

```sh
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
```

Unit-tested with fixtures and mocked `execa` calls: app-type detection, package manager detection, config loading/validation, the directory scanner, the PM2 adapter (argument shapes, status mapping, mocked success/failure), and doctor checks.

**Not unit tested** (requires a real environment): actual `pm2 start` process lifecycle, real `npm install`/build execution, and full command flows end-to-end. Verify these manually against a couple of toy apps:

```sh
nodeploy init --apps-dir ./my-test-apps
nodeploy deploy
nodeploy list
nodeploy logs my-app
nodeploy restart my-app
nodeploy stop my-app
```

### Known issue: PM2 daemon crash on some machines

On some machines, the PM2 daemon (tested on 5.4.3 and 7.0.3) crashes immediately with `RangeError: Map maximum size exceeded` inside its `pm2-axon` IPC transport, which relies on Node's deprecated `domain` module. This was reproduced identically across Node 18, 22, and 24 on one development machine, ruling out a Node-version incompatibility — it's more likely caused by machine-level process interception (e.g. a corporate security/MDM agent instrumenting every process's socket creation). If `nodeploy doctor` reports PM2 as installed but `deploy`/`list`/`restart`/`stop`/`logs` hang or fail with this error, check `~/.pm2/pm2.log` and investigate what's instrumenting Node processes on that machine — this is an environment issue, not specific to nodeploy.
