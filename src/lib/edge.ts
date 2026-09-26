import { sshExec } from "./ssh.js";
import type { SSHTarget } from "../types.js";

// An "edge" is the one box the router forwards public 80/443 to. It routes
// each app's hostname on to the server running it: plain HTTP (including
// ACME challenges) via a normal port-80 server block, and HTTPS via TLS SNI
// passthrough on 443, so each upstream's own nginx keeps terminating TLS
// with its own certificate. HTTPS apps running on the edge itself are just
// one more upstream: they listen on EDGE_LOCAL_TLS, routed there by host.
//
// Every per-app file is keyed by hostname, not service name — hosts are
// unique by definition, while two apps on different upstreams can easily
// share a service name like "api".

export const EDGE_STREAM_CONF = "/etc/nginx/stream.d/nodeploy.conf";
export const EDGE_ROUTES_DIR = "/etc/nginx/stream.d/nodeploy-routes";

/** Where HTTPS apps running on the edge itself listen, since the SNI router
 * owns 443 — nodeploy routes their hostnames here. Also where hostnames with
 * no route go. */
export const EDGE_LOCAL_TLS = "127.0.0.1:8443";

// `listen ... http2` rather than the newer `http2 on;` directive, which
// nginx < 1.25.1 (e.g. Ubuntu 22.04's 1.18) rejects outright; newer nginx
// only logs a deprecation warning for this form.
export const PUBLIC_TLS_LISTEN = "listen 443 ssl http2;";
export const LOCAL_TLS_LISTEN = `listen ${EDGE_LOCAL_TLS} ssl http2;`;

const NGINX_CONF = "/etc/nginx/nginx.conf";
const STREAM_INCLUDE = "include /etc/nginx/stream.d/*.conf;";

export function edgeSitePath(host: string): string {
  return `/etc/nginx/sites-available/edge.${host}.conf`;
}

export function edgeSiteLink(host: string): string {
  return `/etc/nginx/sites-enabled/edge.${host}.conf`;
}

export function edgeRoutePath(host: string): string {
  return `${EDGE_ROUTES_DIR}/${host}.conf`;
}

// stream {} has to sit at nginx.conf's top level — sites-enabled/ and
// conf.d/ are both included inside http {}, where it isn't allowed.
const STREAM_BLOCK = `
# Added by nodeploy: layer-4 (TCP) proxying for TLS SNI passthrough.
stream {
    ${STREAM_INCLUDE}
}
`;

export function buildEdgeStreamConfig(): string {
  // `hostnames` enables wildcard keys (e.g. *.example.com) in route files.
  return `# Managed by nodeploy. Routes HTTPS by TLS SNI hostname to the upstream
# that holds the certificate, without terminating TLS here. One route file
# per hostname lives in ${EDGE_ROUTES_DIR}/.
map $ssl_preread_server_name $nodeploy_upstream {
    hostnames;
    include ${EDGE_ROUTES_DIR}/*.conf;
    default ${EDGE_LOCAL_TLS};
}

server {
    listen 443;
    listen [::]:443;
    ssl_preread on;
    proxy_pass $nodeploy_upstream;
    proxy_connect_timeout 5s;
}
`;
}

/** `address` is host:port — `<upstream>:443` for a remote app, or
 * EDGE_LOCAL_TLS for one running on the edge itself. */
export function buildEdgeRoute(host: string, address: string): string {
  return `# Managed by nodeploy.
${host} ${address};
`;
}

export function buildEdgeHttpForward(host: string, upstream: string): string {
  return `# Managed by nodeploy. Forwards plain HTTP (including ACME challenges,
# so the upstream can obtain its own certificate) to ${upstream}.
server {
    listen 80;
    listen [::]:80;
    server_name ${host};

    location / {
        proxy_pass http://${upstream};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
}

/** Splits `nginx -T` output into each config file's path and contents. */
export function parseNginxDump(nginxDump: string): Map<string, string> {
  const files = new Map<string, string>();
  let currentFile: string | null = null;
  let lines: string[] = [];

  const flush = () => {
    if (currentFile !== null) files.set(currentFile, lines.join("\n"));
  };

  for (const line of nginxDump.split("\n")) {
    const header = line.match(/^# configuration file (.+):$/);
    if (header) {
      flush();
      currentFile = header[1];
      lines = [];
    } else {
      lines.push(line);
    }
  }
  flush();

  return files;
}

function listensOn443(content: string): boolean {
  return content.split("\n").some((rawLine) => {
    const listen = rawLine.replace(/#.*/, "").match(/^\s*listen\s+([^\s;]+)/);
    return (
      listen !== null && (listen[1] === "443" || listen[1].endsWith(":443"))
    );
  });
}

/** Returns the config files (from `nginx -T` output) with an active listener
 * on port 443, other than `ownFile`. The SNI router needs 443 to itself. */
export function findPort443Conflicts(nginxDump: string, ownFile: string): string[] {
  return [...parseNginxDump(nginxDump)]
    .filter(([file, content]) => file !== ownFile && listensOn443(content))
    .map(([file]) => file);
}

/** If `content` is an HTTPS site nodeploy itself wrote (see nginx.ts), returns
 * its host and the same site listening on EDGE_LOCAL_TLS instead of 443.
 * Returns null for anything else, which the caller must not touch. */
export function localizeNodeploySite(
  content: string,
): { host: string; content: string } | null {
  if (!content.includes(PUBLIC_TLS_LISTEN)) return null;
  if (!content.includes("ssl_certificate /etc/letsencrypt/live/")) return null;

  const host = content.match(/^\s*server_name\s+([^\s;]+);/m)?.[1];
  if (!host) return null;

  const localized = content.replace(PUBLIC_TLS_LISTEN, LOCAL_TLS_LISTEN);
  // Any other 443 listener means it isn't the plain shape nodeploy writes.
  if (listensOn443(localized)) return null;

  return { host, content: localized };
}

/** Plans moving HTTPS sites already on 443 off it so the SNI router can take
 * over: nodeploy's own app sites move to EDGE_LOCAL_TLS with a route each;
 * anything else is returned as `foreign`, since rewriting it could break it.
 * Writes go through the sites-enabled path nginx actually loaded, so they
 * land wherever its symlink points. */
export function planLocalTLSMigration(nginxDump: string): {
  ops: NginxFileOp[];
  hosts: string[];
  foreign: string[];
} {
  const files = parseNginxDump(nginxDump);
  const ops: NginxFileOp[] = [];
  const hosts: string[] = [];
  const foreign: string[] = [];

  for (const file of findPort443Conflicts(nginxDump, EDGE_STREAM_CONF)) {
    const localized = file.startsWith("/etc/nginx/sites-enabled/")
      ? localizeNodeploySite(files.get(file) ?? "")
      : null;
    if (!localized) {
      foreign.push(file);
      continue;
    }

    ops.push(
      { path: file, content: localized.content },
      {
        path: edgeRoutePath(localized.host),
        content: buildEdgeRoute(localized.host, EDGE_LOCAL_TLS),
      },
    );
    hosts.push(localized.host);
  }

  return { ops, hosts, foreign };
}

export type NginxFileOp =
  | { path: string; content: string; enableAs?: string }
  | { path: string; remove: true; enableAs?: string }
  | { path: string; appendIfMissing: { marker: string; content: string } };

const HEREDOC = "NODEPLOY_EOF";

/** Builds a bash script that applies every op, then runs `nginx -t`: on
 * success it reloads nginx, on failure (or any error midway) it restores
 * every touched file and symlink to its prior state. The edge is shared by
 * every app routed through it, so a bad file left behind would break the
 * next reload for all of them, not just this app. */
export function buildApplyScript(ops: NginxFileOp[]): string {
  const init: string[] = [];
  const apply: string[] = [];
  const restore: string[] = [];
  const cleanup: string[] = [];

  ops.forEach((op, i) => {
    const prev = `${op.path}.nodeploy-prev`;
    const link = "appendIfMissing" in op ? undefined : op.enableAs;

    init.push(`touched_${i}=0`, `had_link_${i}=0`);

    apply.push(
      `sudo rm -f "${prev}"`,
      `if [ -e "${op.path}" ]; then sudo cp -p "${op.path}" "${prev}"; fi`,
      `touched_${i}=1`,
    );
    if (link) {
      apply.push(`if [ -L "${link}" ]; then had_link_${i}=1; fi`);
    }

    if ("remove" in op) {
      apply.push(`sudo rm -f "${op.path}"`);
      if (link) apply.push(`sudo rm -f "${link}"`);
    } else if ("appendIfMissing" in op) {
      apply.push(
        `if ! sudo grep -qF '${op.appendIfMissing.marker}' "${op.path}"; then`,
        `sudo tee -a "${op.path}" > /dev/null <<'${HEREDOC}'`,
        op.appendIfMissing.content.replace(/\n$/, ""),
        HEREDOC,
        "fi",
      );
    } else {
      apply.push(
        `sudo mkdir -p "$(dirname "${op.path}")"`,
        `sudo tee "${op.path}" > /dev/null <<'${HEREDOC}'`,
        op.content.replace(/\n$/, ""),
        HEREDOC,
      );
      if (link) apply.push(`sudo ln -sf "${op.path}" "${link}"`);
    }

    restore.push(
      `  if [ "$touched_${i}" = 1 ]; then`,
      // cp, not mv: writes back through op.path if it's a symlink, rather
      // than replacing the link itself with a regular file.
      `    if [ -e "${prev}" ]; then sudo cp -p "${prev}" "${op.path}"; sudo rm -f "${prev}"; else sudo rm -f "${op.path}"; fi`,
    );
    if (link) {
      restore.push(
        `    if [ "$had_link_${i}" = 1 ]; then sudo ln -sf "${op.path}" "${link}"; else sudo rm -f "${link}"; fi`,
      );
    }
    restore.push("  fi");

    cleanup.push(`sudo rm -f "${prev}"`);
  });

  return [
    "set -eu",
    ...init,
    "restore() {",
    ...restore,
    "  true",
    "}",
    "trap 'restore; exit 1' ERR",
    ...apply,
    "trap - ERR",
    "if ! sudo nginx -t; then",
    "  restore",
    "  exit 1",
    "fi",
    "sudo systemctl reload nginx",
    ...cleanup,
    "",
  ].join("\n");
}

export async function applyNginxChanges(
  target: SSHTarget,
  ops: NginxFileOp[],
): Promise<void> {
  await sshExec(target, "bash -s", { input: buildApplyScript(ops) });
}

export async function isEdgeBootstrapped(target: SSHTarget): Promise<boolean> {
  try {
    await sshExec(target, `test -f "${EDGE_STREAM_CONF}"`);
    return true;
  } catch {
    return false;
  }
}

/** One-time edge setup for HTTPS routing: the top-level stream {} include and
 * the SNI router. Assumes nginx + its stream module are installed. nodeploy
 * HTTPS apps already on this box move to EDGE_LOCAL_TLS in the same
 * transaction (returned as the hosts moved); anything else on 443 makes
 * this refuse rather than silently fight over the port. */
export async function bootstrapEdge(target: SSHTarget): Promise<string[]> {
  const { stdout } = await sshExec(target, "sudo nginx -T 2>/dev/null");
  const migration = planLocalTLSMigration(stdout);
  if (migration.foreign.length > 0) {
    throw new Error(
      `port 443 on ${target.host} is already used by ${migration.foreign.join(", ")} — the edge's SNI router needs 443 to itself. Remove those listeners, or move them to ${EDGE_LOCAL_TLS} and add a route for their hostname in ${EDGE_ROUTES_DIR}/, then re-run setup.`,
    );
  }

  await sshExec(target, `sudo mkdir -p "${EDGE_ROUTES_DIR}"`);
  await applyNginxChanges(target, [
    {
      path: NGINX_CONF,
      appendIfMissing: { marker: STREAM_INCLUDE, content: STREAM_BLOCK },
    },
    { path: EDGE_STREAM_CONF, content: buildEdgeStreamConfig() },
    ...migration.ops,
  ]);
  return migration.hosts;
}

/** Points `host` at `upstream` on the edge: always the port-80 forward, plus
 * the 443 SNI route when the app serves HTTPS (removed again if SSL is later
 * turned off, so the hostname stops routing to a 443 that's gone). */
export async function deployEdgeRoute(
  target: SSHTarget,
  host: string,
  upstream: string,
  ssl: boolean,
): Promise<void> {
  if (ssl && !(await isEdgeBootstrapped(target))) {
    throw new Error(
      `edge ${target.host} isn't set up for HTTPS routing yet — run \`nodeploy setup\` first`,
    );
  }

  await applyNginxChanges(target, [
    {
      path: edgeSitePath(host),
      content: buildEdgeHttpForward(host, upstream),
      enableAs: edgeSiteLink(host),
    },
    ssl
      ? {
          path: edgeRoutePath(host),
          content: buildEdgeRoute(host, `${upstream}:443`),
        }
      : { path: edgeRoutePath(host), remove: true },
  ]);
}
