import { sshExec } from "./ssh.js";
import type { SSHTarget } from "../types.js";

// Cloudflare DNS-01 for certbot: the API token lives on the server (certbot
// needs it for every renewal, not just the first issuance), in a root-only
// file certbot's dns-cloudflare plugin reads. One file per hostname, so apps
// on different Cloudflare accounts each get their own token.

const CREDENTIALS_DIR = "/etc/letsencrypt/nodeploy";

export function cloudflareCredentialsPath(host: string): string {
  return `${CREDENTIALS_DIR}/cloudflare-${host}.ini`;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,}$/;

/** Returns true if the certbot Cloudflare plugin had to be installed.
 * Requires passwordless sudo. Installed from apt, alongside the apt certbot
 * `ensureCertbot` installs, so they share a Python and version. */
export async function ensureCertbotDnsCloudflare(
  target: SSHTarget,
): Promise<boolean> {
  const present = await sshExec(
    target,
    "python3 -c 'import certbot_dns_cloudflare'",
  )
    .then(() => true)
    .catch(() => false);
  if (present) return false;

  await sshExec(
    target,
    "sudo apt-get update && sudo apt-get install -y python3-certbot-dns-cloudflare",
    { stdio: "inherit" },
  );
  return true;
}

/** Stores `token` for `host`, root-only (certbot refuses credentials files
 * others can read). Sent over stdin, never on a command line, so it doesn't
 * show up in the server's process list. Replaces any existing token. */
export async function writeCloudflareCredentials(
  target: SSHTarget,
  host: string,
  token: string,
): Promise<void> {
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(
      "that doesn't look like a Cloudflare API token (expected a long string of letters, digits, - and _)",
    );
  }

  const path = cloudflareCredentialsPath(host);
  await sshExec(
    target,
    [
      `sudo mkdir -p "${CREDENTIALS_DIR}"`,
      `sudo chmod 700 "${CREDENTIALS_DIR}"`,
      `sudo sh -c 'umask 077; cat > "${path}"'`,
    ].join(" && "),
    {
      input: `# Managed by nodeploy: Cloudflare API token for ${host}'s DNS-01 challenge.\ndns_cloudflare_api_token = ${token}\n`,
    },
  );
}

export async function hasCloudflareCredentials(
  target: SSHTarget,
  host: string,
): Promise<boolean> {
  try {
    await sshExec(target, `sudo test -f "${cloudflareCredentialsPath(host)}"`);
    return true;
  } catch {
    return false;
  }
}

export async function removeCloudflareCredentials(
  target: SSHTarget,
  host: string,
): Promise<void> {
  await sshExec(target, `sudo rm -f "${cloudflareCredentialsPath(host)}"`);
}

export type CloudflareTokenStatus = "active" | "missing" | "invalid";

/** Asks Cloudflare whether the stored token is active. The token is read on
 * the server and piped into curl as a header file (-H @-) via the shell's
 * builtin printf, so it's never an argument of any process. */
export async function verifyCloudflareToken(
  target: SSHTarget,
  host: string,
): Promise<CloudflareTokenStatus> {
  if (!(await hasCloudflareCredentials(target, host))) return "missing";

  const path = cloudflareCredentialsPath(host);
  try {
    const { stdout } = await sshExec(
      target,
      `sudo sh -c 't=$(sed -n "s/^dns_cloudflare_api_token = //p" "${path}"); printf "Authorization: Bearer %s\\n" "$t" | curl -s -m 10 -H @- https://api.cloudflare.com/client/v4/user/tokens/verify'`,
    );
    return /"status"\s*:\s*"active"/.test(stdout) ? "active" : "invalid";
  } catch {
    return "invalid";
  }
}
