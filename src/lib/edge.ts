import { sshExec } from "./ssh.js";
import type { SSHTarget } from "../types.js";

// An "edge" is the one box the router forwards public 80/443 to. It never
// runs apps or holds certs itself — it routes each app's hostname on to the
// server that does: plain HTTP (including ACME challenges) via a normal
// port-80 server block, and HTTPS via TLS SNI passthrough on 443, so each
// upstream's own nginx keeps terminating TLS with its own certificate.
//
// Every per-app file is keyed by hostname, not service name — hosts are
// unique by definition, while two apps on different upstreams can easily
// share a service name like "api".

export const EDGE_STREAM_CONF = "/etc/nginx/stream.d/nodeploy.conf";
export const EDGE_ROUTES_DIR = "/etc/nginx/stream.d/nodeploy-routes";

/** Where hostnames with no route go. Nothing listens here unless the edge
 * serves HTTPS itself, in which case those sites must move here, since the
 * SNI router owns 443. */
export const EDGE_LOCAL_TLS = "127.0.0.1:8443";

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

export function buildEdgeRoute(host: string, upstream: string): string {
  return `# Managed by nodeploy.
${host} ${upstream}:443;
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

/** Returns the config files (from `nginx -T` output) with an active listener
 * on port 443, other than `ownFile`. The SNI router needs 443 to itself. */
export function findPort443Conflicts(nginxDump: string, ownFile: string): string[] {
  const conflicts = new Set<string>();
  let currentFile = "";

  for (const rawLine of nginxDump.split("\n")) {
    const header = rawLine.match(/^# configuration file (.+):$/);
    if (header) {
      currentFile = header[1];
      continue;
    }

    const line = rawLine.replace(/#.*/, "");
    const listen = line.match(/^\s*listen\s+([^\s;]+)/);
    if (!listen || currentFile === ownFile) continue;

    const address = listen[1];
    if (address === "443" || address.endsWith(":443")) {
      conflicts.add(currentFile);
    }
  }

  return [...conflicts];
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
      `    if [ -e "${prev}" ]; then sudo mv "${prev}" "${op.path}"; else sudo rm -f "${op.path}"; fi`,
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
 * the SNI router. Assumes nginx + its stream module are installed. Refuses
 * (rather than silently fighting) if something else already listens on 443. */
export async function bootstrapEdge(target: SSHTarget): Promise<void> {
  const { stdout } = await sshExec(target, "sudo nginx -T 2>/dev/null");
  const conflicts = findPort443Conflicts(stdout, EDGE_STREAM_CONF);
  if (conflicts.length > 0) {
    throw new Error(
      `port 443 on ${target.host} is already used by ${conflicts.join(", ")} — the edge's SNI router needs 443 to itself. Remove those listeners, or move HTTPS sites served by the edge itself to ${EDGE_LOCAL_TLS}, then re-run setup.`,
    );
  }

  await sshExec(target, `sudo mkdir -p "${EDGE_ROUTES_DIR}"`);
  await applyNginxChanges(target, [
    {
      path: NGINX_CONF,
      appendIfMissing: { marker: STREAM_INCLUDE, content: STREAM_BLOCK },
    },
    { path: EDGE_STREAM_CONF, content: buildEdgeStreamConfig() },
  ]);
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
      ? { path: edgeRoutePath(host), content: buildEdgeRoute(host, upstream) }
      : { path: edgeRoutePath(host), remove: true },
  ]);
}
