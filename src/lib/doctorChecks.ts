import { toEdgeSSHTarget } from "./deployConfig.js";
import {
  EDGE_LOCAL_PP,
  EDGE_PP_PORT,
  EDGE_STREAM_CONF,
  edgeRoutePath,
  edgeSiteLink,
} from "./edge.js";
import { certificateDir } from "./nginx.js";
import { withNvm } from "./remoteEnv.js";
import { sshExec, sshTest } from "./ssh.js";
import type { DeployConfig, DoctorCheckResult, SSHTarget } from "../types.js";

export async function checkSSHConnection(
  target: SSHTarget,
): Promise<DoctorCheckResult> {
  const ok = await sshTest(target);
  return ok
    ? { name: "SSH", ok: true, message: `connected to ${target.host}` }
    : {
        name: "SSH",
        ok: false,
        message: `could not connect to ${target.user}@${target.host}:${target.port}`,
      };
}

async function checkRemoteBinary(
  target: SSHTarget,
  name: string,
  versionArgs: string,
  opts: { optional?: boolean; hint?: string } = {},
): Promise<DoctorCheckResult> {
  try {
    const { stdout } = await sshExec(target, withNvm(`${name} ${versionArgs}`));
    return { name, ok: true, message: stdout.trim() };
  } catch {
    return {
      name,
      ok: false,
      message: opts.hint ?? `${name} not found on remote PATH`,
      optional: opts.optional,
    };
  }
}

export function checkNode(target: SSHTarget): Promise<DoctorCheckResult> {
  return checkRemoteBinary(target, "node", "--version");
}

export function checkNpm(target: SSHTarget): Promise<DoctorCheckResult> {
  return checkRemoteBinary(target, "npm", "--version");
}

export function checkPnpm(target: SSHTarget): Promise<DoctorCheckResult> {
  return checkRemoteBinary(target, "pnpm", "--version", { optional: true });
}

export function checkPM2(target: SSHTarget): Promise<DoctorCheckResult> {
  return checkRemoteBinary(target, "pm2", "--version", {
    hint: "pm2 not found on remote PATH — install with `npm i -g pm2`",
  });
}

export function checkPython(target: SSHTarget): Promise<DoctorCheckResult> {
  return checkRemoteBinary(target, "python3", "--version", {
    hint: "python3 not found on remote PATH — required for runtime: python",
  });
}

export function checkNginx(target: SSHTarget): Promise<DoctorCheckResult> {
  return checkRemoteBinary(target, "nginx", "-v", {
    optional: true,
    hint: "nginx not found on remote PATH (optional unless using proxy)",
  });
}

export function checkCertbot(target: SSHTarget): Promise<DoctorCheckResult> {
  return checkRemoteBinary(target, "certbot", "--version", {
    hint: "certbot not found on remote PATH — required for proxy.ssl, run `nodeploy setup`",
  });
}

/** certbot's timer renews at 30 days left, so a cert inside this window
 * means renewal has been failing. */
const CERT_EXPIRY_WARNING_DAYS = 14;

export async function checkCertificate(
  target: SSHTarget,
  host: string,
  now: Date = new Date(),
): Promise<DoctorCheckResult> {
  let stdout: string;
  try {
    ({ stdout } = await sshExec(
      target,
      `sudo openssl x509 -enddate -noout -in "${certificateDir(host)}/fullchain.pem"`,
    ));
  } catch {
    return {
      name: "TLS certificate",
      ok: false,
      message: `no certificate for ${host} yet — \`nodeploy deploy\` issues one`,
      optional: true,
    };
  }

  // Output looks like: notAfter=Dec 25 12:00:00 2026 GMT
  const expiresAt = new Date(stdout.trim().replace(/^notAfter=/, ""));
  if (Number.isNaN(expiresAt.getTime())) {
    return {
      name: "TLS certificate",
      ok: false,
      message: `could not parse expiry for ${host}: ${stdout.trim()}`,
      optional: true,
    };
  }

  const daysLeft = Math.floor(
    (expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (daysLeft < CERT_EXPIRY_WARNING_DAYS) {
    return {
      name: "TLS certificate",
      ok: false,
      message:
        daysLeft < 0
          ? `certificate for ${host} expired ${-daysLeft} day(s) ago — check \`sudo certbot renew --dry-run\` on the server`
          : `certificate for ${host} expires in ${daysLeft} day(s) — auto-renewal may be failing, check \`sudo certbot renew --dry-run\` on the server`,
    };
  }

  return {
    name: "TLS certificate",
    ok: true,
    message: `${host} valid for ${daysLeft} more day(s)`,
  };
}

/** Checks the edge has this app's routes in place (and, for HTTPS, the SNI
 * router), without requiring them before the first deploy writes them. */
export async function checkEdgeRouting(
  edgeTarget: SSHTarget,
  host: string,
  upstream: string,
  ssl: boolean,
): Promise<DoctorCheckResult> {
  const name = "Edge routing";
  let present: string[];
  let routeLine = "";
  try {
    const { stdout } = await sshExec(
      edgeTarget,
      [
        `if [ -f "${EDGE_STREAM_CONF}" ]; then echo router; fi`,
        `if [ -e "${edgeSiteLink(host)}" ]; then echo site; fi`,
        `if [ -f "${edgeRoutePath(host)}" ]; then echo route; grep -v '^#' "${edgeRoutePath(host)}"; fi`,
      ].join("; "),
    );
    present = stdout.split("\n").map((line) => line.trim());
    routeLine = present.find((line) => line.startsWith(`${host} `)) ?? "";
  } catch {
    return {
      name,
      ok: false,
      message: `could not connect to edge ${edgeTarget.user}@${edgeTarget.host}:${edgeTarget.port}`,
    };
  }

  if (ssl && !present.includes("router")) {
    return {
      name,
      ok: false,
      message: `edge ${edgeTarget.host} isn't set up for HTTPS routing — run \`nodeploy setup\``,
    };
  }

  if (!present.includes("site") || (ssl && !present.includes("route"))) {
    return {
      name,
      ok: false,
      message: `no route for ${host} on edge ${edgeTarget.host} yet — \`nodeploy deploy\` writes it`,
      optional: true,
    };
  }

  // Routes deployed before real-client-IP support go to plain 443.
  if (ssl && !routeLine.endsWith(`:${EDGE_PP_PORT};`)) {
    return {
      name,
      ok: false,
      message: `edge ${edgeTarget.host} routes ${host}'s HTTPS without PROXY protocol, so the app sees the edge's IP instead of the client's — \`nodeploy deploy\` again to fix`,
      optional: true,
    };
  }

  return {
    name,
    ok: true,
    message: `${edgeTarget.host} routes ${host} → ${upstream} (${ssl ? `http + https, real client IPs via PROXY protocol on :${EDGE_PP_PORT}` : "http"})`,
  };
}

/** For an HTTPS app deployed onto an edge box itself: checks the SNI router
 * sends its host to the local TLS listener. Returns null when the server
 * isn't an edge, since there's nothing to check. */
export async function checkLocalEdgeRoute(
  target: SSHTarget,
  host: string,
): Promise<DoctorCheckResult | null> {
  const name = "Edge routing";
  let stdout: string;
  try {
    ({ stdout } = await sshExec(
      target,
      `if [ -f "${EDGE_STREAM_CONF}" ]; then echo router; cat "${edgeRoutePath(host)}" 2>/dev/null; fi`,
    ));
  } catch {
    return null;
  }

  if (!stdout.includes("router")) return null;

  if (!stdout.includes(`${host} ${EDGE_LOCAL_PP};`)) {
    return {
      name,
      ok: false,
      message: `${target.host} is an edge, but its SNI router doesn't send ${host} to ${EDGE_LOCAL_PP} (with real client IPs) yet — \`nodeploy deploy\` writes the route`,
      optional: true,
    };
  }

  return {
    name,
    ok: true,
    message: `${target.host} is an edge; HTTPS for ${host} is routed to ${EDGE_LOCAL_PP} on the same box, with real client IPs`,
  };
}

/** HTTPS through the edge arrives on the upstream's EDGE_PP_PORT listener,
 * which a firewall on the upstream could block even with 80/443 open.
 * Optional, since nothing listens there until the first deploy. */
export async function checkEdgeProxyProtocolPort(
  edgeTarget: SSHTarget,
  upstream: string,
): Promise<DoctorCheckResult> {
  const name = `Edge → upstream :${EDGE_PP_PORT}`;
  try {
    await sshExec(
      edgeTarget,
      `timeout 5 bash -c '</dev/tcp/${upstream}/${EDGE_PP_PORT}'`,
    );
    return {
      name,
      ok: true,
      message: `${upstream}:${EDGE_PP_PORT} reachable from edge (HTTPS with real client IPs)`,
    };
  } catch {
    return {
      name,
      ok: false,
      message: `edge ${edgeTarget.host} can't reach ${upstream}:${EDGE_PP_PORT} — expected before the first deploy; otherwise allow that port from the edge in ${upstream}'s firewall`,
      optional: true,
    };
  }
}

/** The edge forwards to the upstream's nginx on 80/443, so the upstream has
 * to be reachable from the edge — not just from wherever doctor runs. */
export async function checkEdgeUpstream(
  edgeTarget: SSHTarget,
  host: string,
  upstream: string,
): Promise<DoctorCheckResult> {
  const name = "Edge → upstream";
  try {
    const { stdout } = await sshExec(
      edgeTarget,
      `curl -s -o /dev/null -m 5 -w '%{http_code}' -H "Host: ${host}" "http://${upstream}/"`,
    );
    const code = stdout.trim();
    if (code !== "000" && code !== "") {
      return { name, ok: true, message: `${upstream}:80 reachable from edge (HTTP ${code})` };
    }
  } catch {
    // curl exits non-zero on connection failure; fall through.
  }
  return {
    name,
    ok: false,
    message: `edge ${edgeTarget.host} can't reach ${upstream}:80 — check proxy.edge.upstream and the network between them`,
  };
}

export async function checkDiskSpace(
  target: SSHTarget,
): Promise<DoctorCheckResult> {
  try {
    const { stdout } = await sshExec(target, "df -h $HOME");
    const lastLine = stdout.trim().split("\n").pop() ?? "";
    return { name: "Disk", ok: true, message: lastLine.trim(), optional: true };
  } catch (error) {
    return {
      name: "Disk",
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      optional: true,
    };
  }
}

export async function checkMemory(
  target: SSHTarget,
): Promise<DoctorCheckResult> {
  try {
    const { stdout } = await sshExec(target, "free -h");
    const memLine = stdout
      .trim()
      .split("\n")
      .find((line) => line.startsWith("Mem:"));
    return {
      name: "RAM",
      ok: true,
      message: memLine?.trim() ?? stdout.trim(),
      optional: true,
    };
  } catch (error) {
    return {
      name: "RAM",
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      optional: true,
    };
  }
}

export async function checkDeployPathWritable(
  target: SSHTarget,
  deployPath: string,
): Promise<DoctorCheckResult> {
  try {
    await sshExec(
      target,
      `mkdir -p "${deployPath}" && test -w "${deployPath}"`,
    );
    return { name: "Deploy path", ok: true, message: deployPath };
  } catch {
    return {
      name: "Deploy path",
      ok: false,
      message: `${deployPath} is not writable`,
    };
  }
}

export async function checkPasswordlessSudo(
  target: SSHTarget,
): Promise<DoctorCheckResult> {
  try {
    await sshExec(target, "sudo -n true");
    return { name: "sudo", ok: true, message: "passwordless sudo available" };
  } catch {
    return {
      name: "sudo",
      ok: false,
      message:
        "passwordless sudo not available — required by `nodeploy setup` to install packages, and by `proxy` to write nginx config",
    };
  }
}

export async function runAllChecks(
  config: DeployConfig,
  target: SSHTarget,
): Promise<DoctorCheckResult[]> {
  const connection = await checkSSHConnection(target);
  if (!connection.ok) {
    return [connection];
  }

  const checks: Promise<DoctorCheckResult | null>[] = [
    checkNode(target),
    checkNpm(target),
    checkPnpm(target),
    checkPM2(target),
    checkNginx(target),
    checkDiskSpace(target),
    checkMemory(target),
    checkDeployPathWritable(target, config.deployPath),
    checkPasswordlessSudo(target),
  ];

  if (config.runtime === "python") {
    checks.push(checkPython(target));
  }

  if (config.proxy?.ssl) {
    checks.push(checkCertbot(target), checkCertificate(target, config.proxy.host));
  }

  if (config.proxy?.ssl && !config.proxy.edge) {
    checks.push(checkLocalEdgeRoute(target, config.proxy.host));
  }

  if (config.proxy?.edge) {
    const { host, ssl, edge } = config.proxy;
    const edgeTarget = toEdgeSSHTarget(edge);
    checks.push(
      checkEdgeRouting(edgeTarget, host, edge.upstream, Boolean(ssl)),
      checkEdgeUpstream(edgeTarget, host, edge.upstream),
    );
    if (ssl) {
      checks.push(checkEdgeProxyProtocolPort(edgeTarget, edge.upstream));
    }
  }

  const results = await Promise.all(checks);
  return [
    connection,
    ...results.filter((result): result is DoctorCheckResult => result !== null),
  ];
}
