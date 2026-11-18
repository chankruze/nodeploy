import { createHash } from "node:crypto";
import { NODEPLOY_CREDIT, NODEPLOY_URL } from "../constants.js";
import { shellQuote } from "./logRotation.js";
import type { BackupDownloadConfig, BackupEmailConfig } from "../types.js";

// Backup emails and download links. Everything here runs on the app server,
// inside the backup script (cron) or small scripts nodeploy pipes over SSH:
// the email goes out with curl's SMTP support, and links are served by the
// server's nginx through `secure_link`, so a link works only with a valid
// signature and only until it expires.

/** Where downloadable copies live: readable by nginx (group www-data), and
 * outside both the app checkout and the backups themselves. */
export const DOWNLOAD_ROOT = "/var/lib/nodeploy/downloads";
/** URL prefix nginx serves DOWNLOAD_ROOT under. */
export const DOWNLOAD_PREFIX = "/nodeploy-backups/";
/** The signing secret, shared with nginx's secure_link_md5. */
export const DOWNLOAD_SECRET = "$HOME/.nodeploy/download-secret";
/** Included by every nodeploy-generated site (see nginx.ts), so public links
 * work on the app's own HTTPS host once this exists. */
export const DOWNLOAD_SNIPPET = "/etc/nginx/snippets/nodeploy-downloads.conf";
export const DOWNLOAD_SNIPPET_INCLUDE = "/etc/nginx/snippets/nodeploy-downloads*.conf";
/** SMTP credentials, curl netrc format, mode 600. */
export const SMTP_NETRC = "$HOME/.nodeploy/smtp.netrc";

/** The address part of "Name <address>" or a bare address. */
export function emailAddress(value: string): string {
  const match = /<([^>]+)>\s*$/.exec(value);
  return (match ? match[1] : value).trim();
}

export function lanSitePath(port: number): string {
  return `/etc/nginx/sites-available/nodeploy-downloads-${port}.conf`;
}

/** nginx's secure_link_md5 "$secure_link_expires$uri <secret>", in the
 * base64url form it compares against — what the shell's make_link produces. */
export function signDownload(uri: string, expires: number, secret: string): string {
  return createHash("md5")
    .update(`${expires}${uri} ${secret}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Shell functions make_link (prints `DOWNLOAD <uri?md5&expires>
 * <expires-epoch>` for an archive) and prune_links (drops expired copies). */
export function linkFunctions(service: string, download: BackupDownloadConfig): string {
  const days = download.expiresDays;
  return `DL_DIR=${shellQuote(`${DOWNLOAD_ROOT}/${service}`)}
DL_DAYS=${days}
make_link() {
  [ -r "${DOWNLOAD_SECRET}" ] || { printf 'LINK_ERROR\\tno download secret on this server — run nodeploy backup setup\\n'; return 1; }
  token=$(openssl rand -hex 16) || return 1
  file=$(basename -- "$1")
  mkdir -p "$DL_DIR/$token" && cp -- "$1" "$DL_DIR/$token/$file" && chmod 640 "$DL_DIR/$token/$file" \\
    || { printf 'LINK_ERROR\\tcould not prepare the download in %s (run nodeploy backup setup)\\n' "$DL_DIR"; return 1; }
  expires=$(( $(date +%s) + DL_DAYS * 86400 ))
  uri="${DOWNLOAD_PREFIX}${service}/$token/$file"
  md5=$(printf '%s' "$expires$uri $(cat "${DOWNLOAD_SECRET}")" | openssl md5 -binary | openssl base64 | tr '+/' '-_' | tr -d '=')
  printf 'DOWNLOAD\\t%s?md5=%s&expires=%s\\t%s\\n' "$uri" "$md5" "$expires" "$expires"
}
prune_links() {
  [ -d "$DL_DIR" ] && find "$DL_DIR" -mindepth 1 -maxdepth 1 -type d -mmin +$(( DL_DAYS * 1440 )) -exec rm -rf {} + 2>/dev/null
  return 0
}
`;
}

/** Shell function send_mail <subject> <body-file>: prints MAILED or
 * MAIL_ERROR. The password comes from SMTP_NETRC, never the command line. */
export function mailFunctions(email: BackupEmailConfig): string {
  const { host, port } = email.smtp;
  const url = port === 465 ? `smtps://${host}:${port}` : `smtp://${host}:${port}`;
  const tls = port === 465 ? "" : "--ssl-reqd";
  return `MAIL_FROM=${shellQuote(email.from)}
MAIL_TO=${shellQuote(email.to.join(", "))}
send_mail() {
  [ -r "${SMTP_NETRC}" ] || { printf 'MAIL_ERROR\\tno SMTP password on this server — run nodeploy backup setup with NODEPLOY_SMTP_PASSWORD set\\n'; return 1; }
  msg=$(mktemp) || return 1
  {
    printf 'From: %s\\r\\n' "$MAIL_FROM"
    printf 'To: %s\\r\\n' "$MAIL_TO"
    printf 'Subject: %s\\r\\n' "$1"
    printf 'Date: %s\\r\\n' "$(LC_ALL=C date '+%a, %d %b %Y %H:%M:%S %z')"
    printf 'MIME-Version: 1.0\\r\\nContent-Type: text/plain; charset=utf-8\\r\\nContent-Transfer-Encoding: 8bit\\r\\n\\r\\n'
    sed 's/$/\\r/' "$2"
  } > "$msg"
  if err=$(curl -sS --max-time 90 --url ${shellQuote(url)} ${tls} --netrc-file "${SMTP_NETRC}" \\
      --mail-from ${shellQuote(emailAddress(email.from))} ${email.to.map((a) => `--mail-rcpt ${shellQuote(a)}`).join(" ")} \\
      --upload-file "$msg" 2>&1); then
    printf 'MAILED\\t%s\\n' "$1"
  else
    printf 'MAIL_ERROR\\t%s\\n' "$(printf '%s' "$err" | tr '\\n' ' ')"
  fi
  rm -f "$msg"
}
`;
}

export interface NotifyContext {
  service: string;
  /** How the team reaches the server, e.g. 192.168.0.8. */
  server: string;
  /** Base URLs for links, e.g. http://192.168.0.8:8799, https://hrms.example.com */
  lanBase: string | null;
  publicBase: string | null;
  version: string;
}

/** The part of the backup script after the backup ran: reads its output
 * ($OUT, exit code $RC) and sends the daily email for scheduled runs, or a
 * failure email for any failed backup or copy. Runs outside the backup's
 * subshell, so an early `exit` in the backup can't skip it. */
export function notifyStep(ctx: NotifyContext): string {
  const footer = `—\\nSent by nodeploy v${ctx.version} (${NODEPLOY_URL}), built by ${NODEPLOY_CREDIT}.`;
  const links = [
    ctx.lanBase ? `printf '    On the office network: %s%s\\n' ${shellQuote(ctx.lanBase)} "$link"` : "",
    ctx.publicBase ? `printf '    From anywhere:         %s%s\\n' ${shellQuote(ctx.publicBase)} "$link"` : "",
  ]
    .filter(Boolean)
    .join("\n      ");
  return `
BODY=$(mktemp) || exit $RC
WHEN=$(date '+%Y-%m-%d %H:%M %Z')
ARCHIVE=$(grep '^BACKUP' "$OUT" | cut -f2)
SIZE=$(grep '^BACKUP' "$OUT" | cut -f3)
if [ "$RC" != 0 ] || ! grep -q '^BACKUP' "$OUT"; then
  {
    printf 'The %s backup of ${ctx.service} on ${ctx.server} FAILED at %s.\\n\\n' "$REASON" "$WHEN"
    printf 'What the backup reported:\\n\\n'
    T=$(printf '\\t')
    sed -e "s/^ERROR$T/Error: /" -e "s/^MISSING$T/Not found (skipped): /" -e "s/^WARN$T/Warning: /" -e 's/^/    /' "$OUT"
    printf '\\nThe previous backups are untouched. To retry, run from the app folder:\\n    nodeploy backup now\\n\\n${footer}\\n'
  } > "$BODY"
  send_mail "[nodeploy] Backup FAILED: ${ctx.service} on ${ctx.server}" "$BODY"
elif grep -q '^COPY_ERROR' "$OUT"; then
  {
    printf 'The %s backup of ${ctx.service} on ${ctx.server} finished at %s, but copying it to the second server failed:\\n\\n' "$REASON" "$WHEN"
    grep '^COPY_ERROR' "$OUT" | cut -f2 | sed 's/^/    /'
    printf '\\nThe backup itself is safe on ${ctx.server}: %s\\n\\n${footer}\\n' "$ARCHIVE"
  } > "$BODY"
  send_mail "[nodeploy] Backup copy failed: ${ctx.service} on ${ctx.server}" "$BODY"
elif [ "$REASON" = scheduled ]; then
  {
    printf 'The daily backup of ${ctx.service} on ${ctx.server} finished at %s.\\n\\n' "$WHEN"
    printf '    Backup:  %s (%s)\\n' "$(basename -- "$ARCHIVE")" "$(echo "$SIZE" | awk '{ s=$1; u="bytes"; if (s>=1048576) { s=s/1048576; u="MB" } else if (s>=1024) { s=s/1024; u="KB" }; if (u=="bytes") printf "%d %s", s, u; else printf "%.1f %s", s, u }')"
    grep '^COPIED' "$OUT" | cut -f2 | sed 's/^/    Copy:    /'
    if grep -q '^DOWNLOAD' "$OUT"; then
      link=$(grep '^DOWNLOAD' "$OUT" | head -1 | cut -f2)
      exp=$(grep '^DOWNLOAD' "$OUT" | head -1 | cut -f3)
      printf '\\n  Download it (the link expires %s):\\n' "$(date -d "@$exp" '+%Y-%m-%d %H:%M %Z' 2>/dev/null || date -r "$exp" '+%Y-%m-%d %H:%M %Z')"
      ${links || ":"}
      printf '\\n  Anyone with this link can download the backup until it expires — please do not forward it.\\n'
    fi
    grep '^LINK_ERROR' "$OUT" | cut -f2 | sed 's/^/\\n  No download link: /'
    printf '\\nTo restore it, run from the app folder:\\n    nodeploy backup restore %s\\n\\n${footer}\\n' "$(basename -- "$ARCHIVE")"
  } > "$BODY"
  send_mail "[nodeploy] Backup OK: ${ctx.service} on ${ctx.server}, $(date '+%Y-%m-%d')" "$BODY"
fi
rm -f "$BODY"
`;
}

/** Stores the SMTP password (read from stdin) for curl, replacing any
 * earlier entry for the same host and login. */
export function netrcScript(host: string, user: string): string {
  return `set -eu
umask 077
mkdir -p "$HOME/.nodeploy"
IFS= read -r PASS || true
[ -n "$PASS" ] || { echo "empty password" >&2; exit 2; }
esc=$(printf '%s' "$PASS" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
touch "${SMTP_NETRC}"
grep -vF ${shellQuote(`machine ${host} login ${user} `)} "${SMTP_NETRC}" > "${SMTP_NETRC}.tmp" || true
printf 'machine %s login %s password "%s"\\n' ${shellQuote(host)} ${shellQuote(user)} "$esc" >> "${SMTP_NETRC}.tmp"
mv "${SMTP_NETRC}.tmp" "${SMTP_NETRC}"
chmod 600 "${SMTP_NETRC}"
`;
}

/** Whether an entry for this host + login is already stored. */
export function hasNetrcScript(host: string, user: string): string {
  return `grep -qF ${shellQuote(`machine ${host} login ${user} `)} "${SMTP_NETRC}" 2>/dev/null && echo yes || echo no`;
}

/** nginx side of the links, set up once per server: the signing secret,
 * DOWNLOAD_ROOT (group www-data, setgid, so nginx can read what the backup
 * script copies in), the location snippet every nodeploy site includes, and
 * a plain-HTTP listener for the office network. Validated with `nginx -t`,
 * and rolled back if that fails. Needs root or passwordless sudo. */
export function downloadSetupScript(service: string, download: BackupDownloadConfig): string {
  const lanSite = download.lanPort ? lanSitePath(download.lanPort) : null;
  const enabled = lanSite ? lanSite.replace("sites-available", "sites-enabled") : null;
  return `set -eu
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo -n"
command -v nginx >/dev/null 2>&1 || { echo "nginx is not installed on this server" >&2; exit 3; }
umask 077
mkdir -p "$HOME/.nodeploy"
[ -s "${DOWNLOAD_SECRET}" ] || openssl rand -hex 32 > "${DOWNLOAD_SECRET}"
SECRET=$(cat "${DOWNLOAD_SECRET}")
ME=$(id -un)
$SUDO install -d -m 755 /var/lib/nodeploy
$SUDO install -d -o "$ME" -g www-data -m 2750 ${DOWNLOAD_ROOT}
install -d -m 2750 ${shellQuote(`${DOWNLOAD_ROOT}/${service}`)}
umask 022
BK=$(mktemp -d)
for f in ${DOWNLOAD_SNIPPET} ${lanSite ?? ""}; do [ -e "$f" ] && $SUDO cp -p "$f" "$BK/$(basename "$f")"; done
$SUDO mkdir -p /etc/nginx/snippets
$SUDO tee ${DOWNLOAD_SNIPPET} >/dev/null <<NGINX
# Managed by nodeploy: signed, expiring backup downloads (nodeploy backup link).
location ${DOWNLOAD_PREFIX} {
    secure_link \\$arg_md5,\\$arg_expires;
    secure_link_md5 "\\$secure_link_expires\\$uri $SECRET";
    if (\\$secure_link = "") { return 403; }
    if (\\$secure_link = "0") { return 410; }
    alias ${DOWNLOAD_ROOT}/;
    add_header Content-Disposition "attachment" always;
    add_header Cache-Control "no-store" always;
    autoindex off;
}
NGINX
$SUDO chmod 640 ${DOWNLOAD_SNIPPET}
${
  lanSite && enabled
    ? `$SUDO tee ${lanSite} >/dev/null <<NGINX
# Managed by nodeploy: backup download links on the office network.
server {
    listen ${download.lanPort};
    server_name _;
    include ${DOWNLOAD_SNIPPET};
    location / { return 404; }
}
NGINX
$SUDO ln -sf ${lanSite} ${enabled}`
    : ""
}
if $SUDO nginx -t >/dev/null 2>&1; then
  $SUDO systemctl reload nginx 2>/dev/null || $SUDO nginx -s reload
  rm -rf "$BK"
  echo OK
else
  err=$($SUDO nginx -t 2>&1 | tail -3)
  for f in ${DOWNLOAD_SNIPPET} ${lanSite ?? ""}; do
    if [ -e "$BK/$(basename "$f")" ]; then $SUDO cp -p "$BK/$(basename "$f")" "$f"; else $SUDO rm -f "$f"; fi
  done
  ${enabled ? `[ -e ${lanSite} ] || $SUDO rm -f ${enabled}` : ":"}
  rm -rf "$BK"
  echo "nginx rejected the download config (rolled back): $err" >&2
  exit 4
fi
`;
}

/** Whether the app's own site already includes the downloads snippet (it
 * does once deployed by a nodeploy with download support). */
export function siteIncludesSnippetScript(service: string): string {
  return `grep -qF ${shellQuote(DOWNLOAD_SNIPPET_INCLUDE)} /etc/nginx/sites-available/${service}.conf 2>/dev/null && echo yes || echo no`;
}
