import { ensureNginxStreamModule } from "./serverSetup.js";
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
// share a service name like "api". A route's host can also be a wildcard
// (*.example.com): both nginx's server_name and the SNI map prefer an exact
// host over any wildcard, so per-app routes always win over a domain-wide
// default.

export const EDGE_STREAM_CONF = "/etc/nginx/stream.d/nodeploy.conf";
export const EDGE_ROUTES_DIR = "/etc/nginx/stream.d/nodeploy-routes";

/** Where hostnames with no route go, and where HTTPS apps on the edge
 * itself listened before real-client-IP support (still routed correctly,
 * without the client IP, until they're redeployed onto EDGE_LOCAL_PP). */
export const EDGE_LOCAL_TLS = "127.0.0.1:8443";

// Real client IPs over HTTPS: the SNI router passes TLS through untouched,
// so it can't add X-Forwarded-For — it sends a PROXY protocol header ahead
// of the stream instead. A listener either always expects that header or
// never does, so upstreams keep 443 as-is for direct (LAN) clients and add a
// second listener on EDGE_PP_PORT that expects it, trusting it only from the
// edge's own address. nginx's `proxy_protocol on` can't vary per route, so
// the router always sends the header, and routes to anything other than an
// EDGE_PP_PORT listener go through a loopback hop that strips it off first.
// A route's port alone decides which path it takes.
export const EDGE_PP_PORT = 8444;

/** Where HTTPS apps running on the edge itself listen (the SNI router owns
 * 443), expecting PROXY protocol from the router on loopback. */
export const EDGE_LOCAL_PP = `127.0.0.1:${EDGE_PP_PORT}`;

/** Loopback hop that consumes the router's PROXY header and passes plain TLS
 * on, for upstreams that don't expect the header. */
const EDGE_STRIP_HOP = "127.0.0.1:9443";

// `listen ... http2` rather than the newer `http2 on;` directive, which
// nginx < 1.25.1 (e.g. Ubuntu 22.04's 1.18) rejects outright; newer nginx
// only logs a deprecation warning for this form.
export const PUBLIC_TLS_LISTEN = "listen 443 ssl http2;";
export const EDGE_PP_LISTEN = `listen ${EDGE_PP_PORT} ssl http2 proxy_protocol;`;
export const LOCAL_PP_LISTEN = `listen ${EDGE_LOCAL_PP} ssl http2 proxy_protocol;`;

/** realip directives trusting client addresses from `trusted` only — as the
 * PROXY protocol source on TLS listeners, or X-Forwarded-For on port 80.
 * Must be the edge's exact address: anyone it trusts can claim any client
 * IP, while untrusted senders just keep their own address. */
export function realIPDirectives(
  trusted: string,
  header: "proxy_protocol" | "X-Forwarded-For",
): string {
  return `    set_real_ip_from ${trusted};
    real_ip_header ${header};`;
}

const NGINX_CONF = "/etc/nginx/nginx.conf";
const STREAM_INCLUDE = "include /etc/nginx/stream.d/*.conf;";

const HOST_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;
const UPSTREAM_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

/** Accepts an exact hostname or a `*.domain` wildcard. These end up in both
 * nginx config and shell commands, so nothing else gets through. */
export function assertRouteHost(host: string): void {
  if (!HOST_PATTERN.test(host)) {
    throw new Error(
      `"${host}" isn't a valid route host — use a hostname like app.example.com, or a wildcard like *.example.com`,
    );
  }
}

/** Accepts a hostname or IPv4 address (no port — the edge always forwards
 * to the upstream's nginx on 80/443). */
export function assertUpstream(upstream: string): void {
  if (!UPSTREAM_PATTERN.test(upstream)) {
    throw new Error(
      `"${upstream}" isn't a valid upstream — use a hostname or IPv4 address, without a port`,
    );
  }
}

/** File-name key for a route host. `*` would make file names glob patterns,
 * so wildcards become `_wildcard.<domain>` — `_` can't appear in a real
 * hostname, so this can't collide with an exact host's files. */
function routeKey(host: string): string {
  return host.startsWith("*.") ? `_wildcard.${host.slice(2)}` : host;
}

export function edgeSitePath(host: string): string {
  return `/etc/nginx/sites-available/edge.${routeKey(host)}.conf`;
}

export function edgeSiteLink(host: string): string {
  return `/etc/nginx/sites-enabled/edge.${routeKey(host)}.conf`;
}

export function edgeRoutePath(host: string): string {
  return `${EDGE_ROUTES_DIR}/${routeKey(host)}.conf`;
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

# Upstreams on port ${EDGE_PP_PORT} expect the PROXY protocol header (carrying the
# real client IP) and get it directly; everything else goes via the strip hop.
map $nodeploy_upstream $nodeploy_first_hop {
    ~:${EDGE_PP_PORT}$ $nodeploy_upstream;
    default ${EDGE_STRIP_HOP};
}

server {
    listen 443;
    listen [::]:443;
    ssl_preread on;
    proxy_protocol on;
    proxy_pass $nodeploy_first_hop;
    proxy_connect_timeout 5s;
}

server {
    listen ${EDGE_STRIP_HOP} proxy_protocol;
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
 * its host and the same site listening on EDGE_LOCAL_PP instead of 443.
 * Returns null for anything else, which the caller must not touch. */
export function localizeNodeploySite(
  content: string,
): { host: string; content: string } | null {
  if (!content.includes(PUBLIC_TLS_LISTEN)) return null;
  if (!content.includes("ssl_certificate /etc/letsencrypt/live/")) return null;

  const host = content.match(/^\s*server_name\s+([^\s;]+);/m)?.[1];
  if (!host) return null;

  const localized = content.replace(
    PUBLIC_TLS_LISTEN,
    // The listen line's own indentation stays in `content`; the realip
    // lines after it bring theirs.
    `${LOCAL_PP_LISTEN}\n${realIPDirectives("127.0.0.1", "proxy_protocol")}`,
  );
  // Any other 443 listener means it isn't the plain shape nodeploy writes.
  if (listensOn443(localized)) return null;

  return { host, content: localized };
}

/** Plans moving HTTPS sites already on 443 off it so the SNI router can take
 * over: nodeploy's own app sites move to EDGE_LOCAL_PP with a route each;
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
        content: buildEdgeRoute(localized.host, EDGE_LOCAL_PP),
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
 * HTTPS apps already on this box move to EDGE_LOCAL_PP in the same
 * transaction (returned as the hosts moved); anything else on 443 makes
 * this refuse rather than silently fight over the port. */
export async function bootstrapEdge(target: SSHTarget): Promise<string[]> {
  const { stdout } = await sshExec(target, "sudo nginx -T 2>/dev/null");
  const migration = planLocalTLSMigration(stdout);
  if (migration.foreign.length > 0) {
    throw new Error(
      `port 443 on ${target.host} is already used by ${migration.foreign.join(", ")} — the edge's SNI router needs 443 to itself. Remove those listeners, or move them to ${EDGE_LOCAL_TLS} (no PROXY protocol) and add a route for their hostname in ${EDGE_ROUTES_DIR}/, then re-run setup.`,
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

/** Makes sure the edge can route HTTPS, with the current SNI router: an
 * edge set up before real-client-IP support gets the new router here (it's
 * nodeploy-managed, so rewriting it is safe), since routes to EDGE_PP_PORT
 * only work once the router sends the PROXY header. */
export async function prepareEdgeForHttps(target: SSHTarget): Promise<void> {
  if (!(await isEdgeBootstrapped(target))) {
    throw new Error(
      `edge ${target.host} isn't set up for HTTPS routing yet — run \`nodeploy setup\` first`,
    );
  }

  const expected = buildEdgeStreamConfig();
  const { stdout } = await sshExec(target, `cat "${EDGE_STREAM_CONF}"`);
  if (stdout.trim() !== expected.trim()) {
    await applyNginxChanges(target, [
      { path: EDGE_STREAM_CONF, content: expected },
    ]);
  }
}

/** Writes only the port-80 forward for `host`. deploy does this before
 * configuring the app itself, so ACME challenges already reach it. */
export async function deployEdgeHttpForward(
  target: SSHTarget,
  host: string,
  upstream: string,
): Promise<void> {
  await applyNginxChanges(target, [
    {
      path: edgeSitePath(host),
      content: buildEdgeHttpForward(host, upstream),
      enableAs: edgeSiteLink(host),
    },
  ]);
}

/** Points `host`'s HTTPS at `address` (host:port), or removes the route with
 * null. deploy does this after the app's own nginx is in place, so the
 * route never points at a listener that isn't there yet. */
export async function setEdgeSniRoute(
  target: SSHTarget,
  host: string,
  address: string | null,
): Promise<void> {
  await applyNginxChanges(target, [
    address
      ? { path: edgeRoutePath(host), content: buildEdgeRoute(host, address) }
      : { path: edgeRoutePath(host), remove: true },
  ]);
}

/** Points `host` at `upstream`'s plain 443 (no PROXY protocol — for servers
 * nodeploy doesn't manage, or wildcard defaults): the port-80 forward plus,
 * with `ssl`, the SNI route, in one transaction. Without `ssl`, removes any
 * SNI route left from before. */
export async function deployEdgeRoute(
  target: SSHTarget,
  host: string,
  upstream: string,
  ssl: boolean,
): Promise<void> {
  if (ssl) await prepareEdgeForHttps(target);

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

/** The address the edge's connections to `upstream` come from, as the
 * upstream sees them — the only address the upstream should trust client
 * IPs from. Asks the edge's own routing table, rather than assuming
 * `edge.server` (which may be a hostname, or a different interface). */
export async function edgeSourceAddress(
  target: SSHTarget,
  upstream: string,
): Promise<string> {
  const { stdout } = await sshExec(
    target,
    `ip=$(getent ahostsv4 "${upstream}" | awk 'NR==1{print $1}'); [ -n "$ip" ] && ip -4 route get "$ip" | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p'`,
  );
  const address = stdout.trim().split("\n")[0]?.trim() ?? "";
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
    throw new Error(
      `couldn't work out which address edge ${target.host} uses to reach ${upstream} (got "${stdout.trim()}")`,
    );
  }
  return address;
}

/** Removes every edge route for `host` (port-80 forward and SNI route).
 * Missing files are fine, so this is safe to run for a host with neither. */
export async function removeEdgeRoute(
  target: SSHTarget,
  host: string,
): Promise<void> {
  await applyNginxChanges(target, [
    { path: edgeSitePath(host), remove: true, enableAs: edgeSiteLink(host) },
    { path: edgeRoutePath(host), remove: true },
  ]);
}

/** Sets up the edge for HTTPS routing if it isn't already (and brings an
 * older SNI router up to date if it is). Returns the hosts moved off 443 by
 * bootstrapEdge, if it ran. */
export async function ensureEdgeBootstrapped(
  target: SSHTarget,
): Promise<string[]> {
  if (await isEdgeBootstrapped(target)) {
    await prepareEdgeForHttps(target);
    return [];
  }
  await ensureNginxStreamModule(target);
  return bootstrapEdge(target);
}

export interface EdgeRouteEntry {
  host: string;
  /** Upstream the port-80 forward proxies to. */
  http?: string;
  /** host:port the SNI router sends this host's HTTPS to. */
  https?: string;
}

const LISTING_MARKER = "@@nodeploy";

/** Parses listEdgeRoutes' remote output into one entry per host, sorted so
 * exact hosts list before the wildcards they take precedence over. */
export function parseEdgeListing(stdout: string): EdgeRouteEntry[] {
  const entries = new Map<string, EdgeRouteEntry>();
  const entry = (host: string) => {
    let existing = entries.get(host);
    if (!existing) {
      existing = { host };
      entries.set(host, existing);
    }
    return existing;
  };

  const sections = stdout.split(`${LISTING_MARKER} `).slice(1);
  for (const section of sections) {
    const [kind, ...lines] = section.split("\n");
    const body = lines.map((line) => line.replace(/#.*/, "")).join("\n");

    if (kind.trim() === "site") {
      const host = body.match(/server_name\s+([^\s;]+);/)?.[1];
      const upstream = body.match(/proxy_pass\s+http:\/\/([^\s;/]+)/)?.[1];
      if (host && upstream) entry(host).http = upstream;
    } else if (kind.trim() === "route") {
      const route = body.match(/^\s*(\S+)\s+([^\s;]+);/m);
      if (route) entry(route[1]).https = route[2];
    }
  }

  return [...entries.values()].sort((a, b) => {
    const aWild = a.host.startsWith("*.");
    const bWild = b.host.startsWith("*.");
    if (aWild !== bWild) return aWild ? 1 : -1;
    return a.host.localeCompare(b.host);
  });
}

/** Lists every route nodeploy manages on the edge, whether written by
 * `deploy` (per-app) or `nodeploy edge add` (manual, e.g. wildcards). */
export async function listEdgeRoutes(
  target: SSHTarget,
): Promise<EdgeRouteEntry[]> {
  const { stdout } = await sshExec(
    target,
    [
      `for f in /etc/nginx/sites-enabled/edge.*.conf; do [ -e "$f" ] && { echo "${LISTING_MARKER} site"; cat "$f"; }; done`,
      `for f in ${EDGE_ROUTES_DIR}/*.conf; do [ -e "$f" ] && { echo "${LISTING_MARKER} route"; cat "$f"; }; done`,
      "true",
    ].join("; "),
  );
  return parseEdgeListing(stdout);
}
