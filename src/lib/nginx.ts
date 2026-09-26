import {
  EDGE_LOCAL_PP,
  EDGE_PP_LISTEN,
  LOCAL_PP_LISTEN,
  PUBLIC_TLS_LISTEN,
  applyNginxChanges,
  buildEdgeRoute,
  edgeRoutePath,
  isEdgeBootstrapped,
  realIPDirectives,
} from "./edge.js";
import {
  cloudflareCredentialsPath,
  hasCloudflareCredentials,
} from "./cloudflare.js";
import { CLOUDFLARE_TOKEN_ENV } from "../constants.js";
import { sshExec } from "./ssh.js";
import type { SSHTarget, SSLConfig } from "../types.js";

/** Where certbot drops HTTP-01 challenge files, served by every port-80 block. */
export const ACME_WEBROOT = "/var/www/certbot";

export function certificateDir(host: string): string {
  return `/etc/letsencrypt/live/${host}`;
}

function proxyBody(port: number): string {
  return `    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }`;
}

function staticBody(root: string): string {
  return `    root ${root};
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }`;
}

// Kept in every port-80 block, not just SSL ones: the first-time issuance
// flow serves the challenge from the plain HTTP block before any cert exists,
// and renewals keep hitting it on port 80 after the HTTPS block is in place.
const ACME_LOCATION = `    location /.well-known/acme-challenge/ {
        root ${ACME_WEBROOT};
    }`;

export interface SiteOptions {
  ssl?: boolean;
  /** The app runs on an edge, whose SNI router owns 443: HTTPS listens on
   * EDGE_LOCAL_PP instead, trusting the router's PROXY header on loopback. */
  onEdge?: boolean;
  /** The app sits behind this edge address: HTTPS also listens on
   * EDGE_PP_PORT for the edge's PROXY-protocol connections (443 stays for
   * direct LAN clients), and port 80 trusts its X-Forwarded-For — both
   * from this exact address only. */
  behindEdge?: string;
}

/** Wraps a site body in nginx server block(s). With `ssl`, port 80 only
 * answers ACME challenges and redirects to HTTPS, and the body moves to the
 * HTTPS block (see SiteOptions for where that listens). */
function buildSite(host: string, body: string, opts: SiteOptions): string {
  const httpRealIP = opts.behindEdge
    ? `\n${realIPDirectives(opts.behindEdge, "X-Forwarded-For")}\n`
    : "";

  if (!opts.ssl) {
    return `server {
    listen 80;
    server_name ${host};
${httpRealIP}
${ACME_LOCATION}

${body}
}
`;
  }

  let tlsListen: string;
  if (opts.onEdge) {
    tlsListen = `    ${LOCAL_PP_LISTEN}
${realIPDirectives("127.0.0.1", "proxy_protocol")}`;
  } else if (opts.behindEdge) {
    tlsListen = `    ${PUBLIC_TLS_LISTEN}
    ${EDGE_PP_LISTEN}
${realIPDirectives(opts.behindEdge, "proxy_protocol")}`;
  } else {
    tlsListen = `    ${PUBLIC_TLS_LISTEN}`;
  }

  const certDir = certificateDir(host);
  return `server {
    listen 80;
    server_name ${host};
${httpRealIP}
${ACME_LOCATION}

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
${tlsListen}
    server_name ${host};

    ssl_certificate ${certDir}/fullchain.pem;
    ssl_certificate_key ${certDir}/privkey.pem;

${body}
}
`;
}

export function buildServerBlock(
  host: string,
  port: number,
  opts: SiteOptions = {},
): string {
  return buildSite(host, proxyBody(port), opts);
}

export function buildStaticServerBlock(
  host: string,
  root: string,
  opts: SiteOptions = {},
): string {
  return buildSite(host, staticBody(root), opts);
}

function sitePaths(service: string): { available: string; enabled: string } {
  return {
    available: `/etc/nginx/sites-available/${service}.conf`,
    enabled: `/etc/nginx/sites-enabled/${service}.conf`,
  };
}

async function writeAndReload(
  target: SSHTarget,
  service: string,
  block: string,
): Promise<void> {
  const { available, enabled } = sitePaths(service);

  const remoteCommand = [
    `sudo tee "${available}" > /dev/null`,
    `sudo ln -sf "${available}" "${enabled}"`,
    "sudo nginx -t",
    "sudo systemctl reload nginx",
  ].join(" && ");

  await sshExec(target, remoteCommand, { input: block });
}

/** /etc/letsencrypt/live is root-only, so this needs sudo even to check. */
export async function hasCertificate(
  target: SSHTarget,
  host: string,
): Promise<boolean> {
  try {
    await sshExec(
      target,
      `sudo test -f "${certificateDir(host)}/fullchain.pem"`,
    );
    return true;
  } catch {
    return false;
  }
}

/** certbot's name for the authenticator a config's challenge uses — what a
 * cert's renewal config records, and so what every renewal will use. */
export function wantedAuthenticator(ssl: SSLConfig): string {
  return ssl.dns === "cloudflare" ? "dns-cloudflare" : "webroot";
}

/** Returns the authenticator the host's existing cert renews with (e.g.
 * "webroot"), "" if it has a cert but no renewal config, or null if it has
 * no cert at all. */
export async function certificateAuthenticator(
  target: SSHTarget,
  host: string,
): Promise<string | null> {
  try {
    const { stdout } = await sshExec(
      target,
      `sudo sh -c 'test -f "${certificateDir(host)}/fullchain.pem" && { sed -n "s/^authenticator = //p" "/etc/letsencrypt/renewal/${host}.conf" 2>/dev/null; true; }'`,
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function issueCertificate(
  target: SSHTarget,
  host: string,
  ssl: SSLConfig,
  opts: { replace?: boolean } = {},
): Promise<void> {
  const account = ssl.email
    ? `--email "${ssl.email}"`
    : "--register-unsafely-without-email";

  let prepare: string[];
  let challenge: string;
  let hint: string;
  if (ssl.dns === "cloudflare") {
    if (!(await hasCloudflareCredentials(target, host))) {
      throw new Error(
        `no Cloudflare API token on the server for ${host} — set ${CLOUDFLARE_TOKEN_ENV} locally and re-run \`nodeploy setup\``,
      );
    }
    prepare = [];
    challenge = [
      "--dns-cloudflare",
      `--dns-cloudflare-credentials "${cloudflareCredentialsPath(host)}"`,
      // Cloudflare's own default of 10s is occasionally too short for
      // Let's Encrypt's resolvers to see the new TXT record.
      "--dns-cloudflare-propagation-seconds 30",
    ].join(" ");
    hint = `make sure the Cloudflare API token has Zone → DNS → Edit on ${host}'s zone (set ${CLOUDFLARE_TOKEN_ENV} and re-run \`nodeploy setup\` to replace it)`;
  } else {
    prepare = [`sudo mkdir -p "${ACME_WEBROOT}"`];
    challenge = `--webroot -w "${ACME_WEBROOT}"`;
    hint = `make sure its DNS record points at this server and port 80 is reachable from the internet (the site is still being served over plain HTTP)`;
  }

  // --cert-name pins the lineage dir to the host, so certificateDir() stays
  // correct instead of certbot picking e.g. <host>-0001. --deploy-hook is
  // saved into the cert's renewal config, so certbot's systemd timer reloads
  // nginx after every future renewal too, not just this first issuance.
  // --force-renewal (for `replace`) reissues a still-valid cert, so its
  // renewal config switches to this challenge.
  const remoteCommand = [
    ...prepare,
    [
      "sudo certbot certonly",
      challenge,
      `-d "${host}"`,
      `--cert-name "${host}"`,
      account,
      "--agree-tos --non-interactive",
      ...(opts.replace ? ["--force-renewal"] : []),
      `--deploy-hook "systemctl reload nginx"`,
    ].join(" "),
  ].join(" && ");

  try {
    await sshExec(target, remoteCommand, { stdio: "inherit" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `certbot could not issue a certificate for ${host} — ${hint}. (${reason})`,
    );
  }
}

/** Writes the site config, obtaining a certificate first if SSL is on and
 * none exists yet. A 443 block pointing at a missing cert fails `nginx -t`,
 * so first-time issuance goes through an HTTP-only config that can answer
 * the ACME challenge. certbot only ever writes to /etc/letsencrypt — never
 * to our config — so redeploying can't clobber anything it set up.
 *
 * On an edge box, the site and its SNI route are applied together (and
 * rolled back together), so the router never points at a listener that
 * isn't there. With SSL off, any route left from when it was on is removed.
 * `behindEdge` is the address of the edge in front of this server, if any. */
async function deploySite(
  target: SSHTarget,
  service: string,
  host: string,
  build: (opts: SiteOptions) => string,
  ssl?: SSLConfig,
  behindEdge?: string,
): Promise<void> {
  const onEdge = await isEdgeBootstrapped(target);

  if (ssl) {
    const authenticator = await certificateAuthenticator(target, host);
    // Also reissues when the existing cert renews via a different challenge
    // than configured (e.g. just switched to DNS-01 for a LAN-only server),
    // since renewals would otherwise keep using the old one.
    if (authenticator !== wantedAuthenticator(ssl)) {
      // HTTP-01 needs a port-80 config answering the challenge, and a 443
      // block for a cert that doesn't exist yet would fail nginx -t. DNS-01
      // needs neither, and an existing cert's config already has both.
      if (authenticator === null && !ssl.dns) {
        await writeAndReload(target, service, build({ behindEdge }));
      }
      await issueCertificate(target, host, ssl, {
        replace: authenticator !== null,
      });
    }
  }

  if (!onEdge) {
    await writeAndReload(
      target,
      service,
      build({ ssl: Boolean(ssl), behindEdge }),
    );
    return;
  }

  const { available, enabled } = sitePaths(service);
  await applyNginxChanges(target, [
    {
      path: available,
      content: build({ ssl: Boolean(ssl), onEdge: true }),
      enableAs: enabled,
    },
    ssl
      ? { path: edgeRoutePath(host), content: buildEdgeRoute(host, EDGE_LOCAL_PP) }
      : { path: edgeRoutePath(host), remove: true },
  ]);
}

export async function deployProxyConfig(
  target: SSHTarget,
  service: string,
  host: string,
  port: number,
  ssl?: SSLConfig,
  behindEdge?: string,
): Promise<void> {
  await deploySite(
    target,
    service,
    host,
    (opts) => buildServerBlock(host, port, opts),
    ssl,
    behindEdge,
  );
}

export async function deployStaticProxyConfig(
  target: SSHTarget,
  service: string,
  host: string,
  root: string,
  ssl?: SSLConfig,
  behindEdge?: string,
): Promise<void> {
  // nginx's worker runs as www-data, not the SSH user — if deploy_path defaults
  // to ~/apps/<service> under a root-owned $HOME (mode 700), www-data can't
  // traverse into it to serve the static build, which nginx surfaces as a
  // rewrite/redirection cycle (or a plain 500) rather than a clear permission
  // error. Grant traversal only, not read/listing, on $HOME itself.
  await sshExec(target, "chmod o+x $HOME");
  await deploySite(
    target,
    service,
    host,
    (opts) => buildStaticServerBlock(host, root, opts),
    ssl,
    behindEdge,
  );
}

export async function isStaticSiteEnabled(
  target: SSHTarget,
  service: string,
): Promise<boolean> {
  try {
    await sshExec(target, `test -f "/etc/nginx/sites-enabled/${service}.conf"`);
    return true;
  } catch {
    return false;
  }
}
