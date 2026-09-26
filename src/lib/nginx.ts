import {
  EDGE_LOCAL_TLS,
  LOCAL_TLS_LISTEN,
  PUBLIC_TLS_LISTEN,
  applyNginxChanges,
  buildEdgeRoute,
  edgeRoutePath,
  isEdgeBootstrapped,
} from "./edge.js";
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

/** Wraps a site body in nginx server block(s). With `ssl`, port 80 only
 * answers ACME challenges and redirects to HTTPS, and the body moves to 443
 * — or, with `localTLS` (the app runs on an edge, whose SNI router owns
 * 443), to EDGE_LOCAL_TLS, which the router forwards this host to. */
function buildSite(
  host: string,
  body: string,
  ssl: boolean,
  localTLS: boolean,
): string {
  if (!ssl) {
    return `server {
    listen 80;
    server_name ${host};

${ACME_LOCATION}

${body}
}
`;
  }

  const certDir = certificateDir(host);
  return `server {
    listen 80;
    server_name ${host};

${ACME_LOCATION}

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    ${localTLS ? LOCAL_TLS_LISTEN : PUBLIC_TLS_LISTEN}
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
  ssl = false,
  localTLS = false,
): string {
  return buildSite(host, proxyBody(port), ssl, localTLS);
}

export function buildStaticServerBlock(
  host: string,
  root: string,
  ssl = false,
  localTLS = false,
): string {
  return buildSite(host, staticBody(root), ssl, localTLS);
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

export async function issueCertificate(
  target: SSHTarget,
  host: string,
  ssl: SSLConfig,
): Promise<void> {
  const account = ssl.email
    ? `--email "${ssl.email}"`
    : "--register-unsafely-without-email";

  // --cert-name pins the lineage dir to the host, so certificateDir() stays
  // correct instead of certbot picking e.g. <host>-0001. --deploy-hook is
  // saved into the cert's renewal config, so certbot's systemd timer reloads
  // nginx after every future renewal too, not just this first issuance.
  const remoteCommand = [
    `sudo mkdir -p "${ACME_WEBROOT}"`,
    [
      "sudo certbot certonly --webroot",
      `-w "${ACME_WEBROOT}"`,
      `-d "${host}"`,
      `--cert-name "${host}"`,
      account,
      "--agree-tos --non-interactive",
      `--deploy-hook "systemctl reload nginx"`,
    ].join(" "),
  ].join(" && ");

  try {
    await sshExec(target, remoteCommand, { stdio: "inherit" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `certbot could not issue a certificate for ${host} — make sure its DNS record points at this server and port 80 is reachable from the internet (the site is still being served over plain HTTP). (${reason})`,
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
 * isn't there. With SSL off, any route left from when it was on is removed. */
async function deploySite(
  target: SSHTarget,
  service: string,
  host: string,
  build: (ssl: boolean, localTLS: boolean) => string,
  ssl?: SSLConfig,
): Promise<void> {
  const onEdge = await isEdgeBootstrapped(target);

  if (ssl && !(await hasCertificate(target, host))) {
    await writeAndReload(target, service, build(false, false));
    await issueCertificate(target, host, ssl);
  }

  if (!onEdge) {
    await writeAndReload(target, service, build(Boolean(ssl), false));
    return;
  }

  const { available, enabled } = sitePaths(service);
  await applyNginxChanges(target, [
    { path: available, content: build(Boolean(ssl), true), enableAs: enabled },
    ssl
      ? { path: edgeRoutePath(host), content: buildEdgeRoute(host, EDGE_LOCAL_TLS) }
      : { path: edgeRoutePath(host), remove: true },
  ]);
}

export async function deployProxyConfig(
  target: SSHTarget,
  service: string,
  host: string,
  port: number,
  ssl?: SSLConfig,
): Promise<void> {
  await deploySite(
    target,
    service,
    host,
    (withSSL, localTLS) => buildServerBlock(host, port, withSSL, localTLS),
    ssl,
  );
}

export async function deployStaticProxyConfig(
  target: SSHTarget,
  service: string,
  host: string,
  root: string,
  ssl?: SSLConfig,
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
    (withSSL, localTLS) =>
      buildStaticServerBlock(host, root, withSSL, localTLS),
    ssl,
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
