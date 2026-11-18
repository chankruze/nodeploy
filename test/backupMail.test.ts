import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBackupScript, parseBackupOutput } from "../src/lib/backup.js";
import {
  DOWNLOAD_ROOT,
  downloadSetupScript,
  linkFunctions,
  mailFunctions,
  netrcScript,
  signDownload,
} from "../src/lib/backupMail.js";
import { buildServerBlock } from "../src/lib/nginx.js";
import { validateDeployConfig } from "../src/lib/deployConfig.js";
import type { BackupEmailConfig } from "../src/types.js";

// Real sh, a throwaway $HOME, the download root redirected into it, and a
// `curl` stub that records its arguments and the message it would send.

let home: string;
let bin: string;
let dl: string;

const email: BackupEmailConfig = {
  to: ["hr@example.com", "admin@example.com"],
  from: "Nodeploy Backups <backups@example.com>",
  smtp: { host: "smtp.example.com", port: 587, user: "backups@example.com" },
};
const download = { lanPort: 8799, public: true, expiresDays: 7 };
const SECRET = "test-secret-0123456789";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nodeploy-mail-home-"));
  bin = fs.mkdtempSync(path.join(os.tmpdir(), "nodeploy-mail-bin-"));
  dl = path.join(home, "downloads");
  fs.mkdirSync(path.join(home, ".nodeploy"), { recursive: true });
  fs.writeFileSync(path.join(home, ".nodeploy", "download-secret"), SECRET);
  fs.writeFileSync(path.join(home, ".nodeploy", "smtp.netrc"), 'machine smtp.example.com login backups@example.com password "s3cr3t"\n');
  fs.mkdirSync(path.join(home, "apps", "hrms"), { recursive: true });
  fs.writeFileSync(path.join(home, "apps", "hrms", "hrms-data.json"), '{"employees":[]}\n');
  // curl stub: records args (one per line) and the uploaded message.
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a"; done >> "${bin}/curl-args"
while [ $# -gt 0 ]; do [ "$1" = "--upload-file" ] && cp "$2" "${bin}/mail-$(date +%s%N 2>/dev/null || date +%s)-$$.eml"; shift; done
[ "\${FAKE_SMTP_FAIL:-0}" = 1 ] && { echo "curl: (67) Login denied" >&2; exit 67; }
exit 0
`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(bin, { recursive: true, force: true });
});

const redirect = (script: string) => script.split(DOWNLOAD_ROOT).join(dl);

function sh(script: string, args: string[] = [], env: Record<string, string> = {}): { out: string; code: number } {
  try {
    const out = execFileSync("sh", ["-s", ...args], {
      input: script,
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ...env },
      encoding: "utf-8",
    });
    return { out, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; status?: number };
    return { out: e.stdout ?? "", code: e.status ?? 1 };
  }
}

function mails(): string[] {
  return fs
    .readdirSync(bin)
    .filter((f) => f.endsWith(".eml"))
    .sort()
    .map((f) => fs.readFileSync(path.join(bin, f), "utf-8"));
}

const curlArgs = () => (fs.existsSync(path.join(bin, "curl-args")) ? fs.readFileSync(path.join(bin, "curl-args"), "utf-8") : "");

describe("download links", () => {
  it("signs links exactly as nginx's secure_link_md5 checks them", () => {
    const archive = path.join(home, "2026-11-18_02-17-00_scheduled.tar.gz");
    fs.writeFileSync(archive, "archive bytes");
    const before = Math.floor(Date.now() / 1000);
    const out = sh(redirect(`${linkFunctions("hrms", download)}make_link ${JSON.stringify(archive)}\n`)).out;
    const [tag, link, expires] = out.trim().split("\t");
    expect(tag).toBe("DOWNLOAD");

    const [uri, query] = link.split("?");
    expect(uri).toMatch(/^\/nodeploy-backups\/hrms\/[0-9a-f]{32}\/2026-11-18_02-17-00_scheduled\.tar\.gz$/);
    const params = new URLSearchParams(query);
    expect(params.get("expires")).toBe(expires);
    expect(Number(expires) - before).toBeGreaterThanOrEqual(7 * 86400);
    expect(Number(expires) - before).toBeLessThan(7 * 86400 + 60);
    // Independent re-computation of nginx's check.
    expect(params.get("md5")).toBe(signDownload(uri, Number(expires), SECRET));

    // The downloadable copy, readable by nginx's group.
    const copy = path.join(dl, uri.replace("/nodeploy-backups/", ""));
    expect(fs.readFileSync(copy, "utf-8")).toBe("archive bytes");
    expect(fs.statSync(copy).mode & 0o777).toBe(0o640);
  });

  it("drops expired download copies, keeping current ones", () => {
    fs.mkdirSync(path.join(dl, "hrms", "old"), { recursive: true });
    fs.mkdirSync(path.join(dl, "hrms", "new"), { recursive: true });
    const tenDaysAgo = new Date(Date.now() - 10 * 86400 * 1000);
    fs.utimesSync(path.join(dl, "hrms", "old"), tenDaysAgo, tenDaysAgo);
    sh(redirect(`${linkFunctions("hrms", download)}prune_links\n`));
    expect(fs.readdirSync(path.join(dl, "hrms"))).toEqual(["new"]);
  });

  it("explains a missing secret instead of making an unsigned link", () => {
    fs.rmSync(path.join(home, ".nodeploy", "download-secret"));
    const out = sh(redirect(`${linkFunctions("hrms", download)}make_link /etc/hosts\n`)).out;
    expect(out).toMatch(/^LINK_ERROR\tno download secret/);
  });
});

describe("send_mail", () => {
  it("sends a well-formed message over STARTTLS, with the password only in the netrc file", () => {
    fs.writeFileSync(path.join(home, "body.txt"), "Hello team\nSecond line\n");
    const out = sh(`${mailFunctions(email)}send_mail "Test subject" "$HOME/body.txt"\n`).out;
    expect(out.trim()).toBe("MAILED\tTest subject");

    const args = curlArgs();
    expect(args).toContain("smtp://smtp.example.com:587");
    expect(args).toContain("--ssl-reqd");
    expect(args).toContain(`--netrc-file\n${home}/.nodeploy/smtp.netrc`);
    expect(args).toContain("--mail-from\nbackups@example.com");
    expect(args).toContain("--mail-rcpt\nhr@example.com\n--mail-rcpt\nadmin@example.com");
    expect(args).not.toContain("s3cr3t");

    const [message] = mails();
    expect(message).toMatch(/^From: Nodeploy Backups <backups@example\.com>\r\nTo: hr@example\.com, admin@example\.com\r\nSubject: Test subject\r\nDate: .+\r\nMIME-Version: 1\.0\r\nContent-Type: text\/plain; charset=utf-8\r\n/);
    expect(message).toContain("\r\n\r\nHello team\r\nSecond line\r\n");
  });

  it("uses implicit TLS on port 465", () => {
    fs.writeFileSync(path.join(home, "body.txt"), "x\n");
    sh(`${mailFunctions({ ...email, smtp: { ...email.smtp, port: 465 } })}send_mail s "$HOME/body.txt"\n`);
    expect(curlArgs()).toContain("smtps://smtp.example.com:465");
    expect(curlArgs()).not.toContain("--ssl-reqd");
  });

  it("reports SMTP errors and a missing password", () => {
    fs.writeFileSync(path.join(home, "body.txt"), "x\n");
    expect(sh(`${mailFunctions(email)}send_mail s "$HOME/body.txt"\n`, [], { FAKE_SMTP_FAIL: "1" }).out).toMatch(/^MAIL_ERROR\tcurl: \(67\) Login denied/);
    fs.rmSync(path.join(home, ".nodeploy", "smtp.netrc"));
    expect(sh(`${mailFunctions(email)}send_mail s "$HOME/body.txt"\n`).out).toMatch(/^MAIL_ERROR\tno SMTP password/);
  });
});

describe("backup emails", () => {
  const script = (extra: Partial<Parameters<typeof buildBackupScript>[0]> = {}) =>
    redirect(
      buildBackupScript({
        service: "hrms",
        deployPath: "$HOME/apps/hrms",
        paths: ["hrms-data.json"],
        keep: 14,
        nodeployVersion: "9.9.9",
        email,
        download,
        notify: { server: "192.168.0.8", lanBase: "http://192.168.0.8:8799", publicBase: "https://hrms.example.com" },
        ...extra,
      }),
    );

  it("sends the daily email with both links, how to restore, and the credits", () => {
    const result = parseBackupOutput(sh(script(), ["scheduled"]).out);
    expect(result.error).toBeNull();
    expect(result.mailed).toMatch(/^\[nodeploy\] Backup OK: hrms on 192\.168\.0\.8, \d{4}-\d{2}-\d{2}$/);
    expect(result.download).toMatch(/^\/nodeploy-backups\/hrms\/[0-9a-f]{32}\/.+_scheduled\.tar\.gz\?md5=[\w-]+&expires=\d+$/);

    const [message] = mails();
    expect(message).toMatch(/Backup: {2}\S+_scheduled\.tar\.gz \(\d+(\.\d)? (bytes|KB|MB)\)/);
    expect(message).toContain(`On the office network: http://192.168.0.8:8799${result.download}`);
    expect(message).toContain(`From anywhere:         https://hrms.example.com${result.download}`);
    expect(message).toMatch(/please do not forward it/);
    expect(message).toMatch(/nodeploy backup restore \d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_scheduled\.tar\.gz/);
    expect(message).toContain("Sent by nodeploy v9.9.9 (https://github.com/chankruze/nodeploy), built by Chandan Kumar Mandal.");
  });

  it("emails on failure — even when the backup exits early — with what went wrong", () => {
    fs.rmSync(path.join(home, "apps", "hrms"), { recursive: true });
    const run = sh(script(), ["pre-deploy"]);
    expect(run.code).not.toBe(0);
    const result = parseBackupOutput(run.out);
    expect(result.mailed).toBe("[nodeploy] Backup FAILED: hrms on 192.168.0.8");
    const [message] = mails();
    expect(message).toContain("The pre-deploy backup of hrms on 192.168.0.8 FAILED");
    expect(message).toMatch(/ {4}Error: app directory .* not found/);
    expect(message).not.toContain("ERROR\t");
    expect(message).toContain("nodeploy backup now");
  });

  it("emails when the copy to the second server fails", () => {
    fs.writeFileSync(path.join(bin, "ssh"), "#!/bin/sh\nexit 255\n", { mode: 0o755 });
    const copyTo = { server: "192.168.0.12", ssh: { user: "backup", port: 22 }, path: "nodeploy-backups", keep: 7 };
    const result = parseBackupOutput(sh(script({ copyTo }), ["scheduled"]).out);
    expect(result.archive).not.toBeNull();
    expect(result.mailed).toBe("[nodeploy] Backup copy failed: hrms on 192.168.0.8");
    expect(mails()[0]).toMatch(/could not copy the backup to backup@192\.168\.0\.12/);
  });

  it("sends nothing for a successful manual or pre-deploy backup", () => {
    for (const reason of ["manual", "pre-deploy"]) {
      const result = parseBackupOutput(sh(script(), [reason]).out);
      expect(result.archive).not.toBeNull();
      expect(result.mailed).toBeNull();
      expect(result.download).toBeNull();
    }
    expect(mails()).toEqual([]);
  });

  it("still reports the backup when the email can't be sent", () => {
    const result = parseBackupOutput(sh(script(), ["scheduled"], { FAKE_SMTP_FAIL: "1" }).out);
    expect(result.archive).not.toBeNull();
    expect(result.mailError).toMatch(/Login denied/);
  });
});

describe("netrcScript", () => {
  const store = (password: string) =>
    execFileSync("sh", ["-c", netrcScript("smtp.example.com", "backups@example.com")], {
      input: `${password}\n`,
      env: { ...process.env, HOME: home },
    });

  it("stores the password quoted and escaped, mode 600, replacing an older entry", () => {
    fs.writeFileSync(path.join(home, ".nodeploy", "smtp.netrc"), 'machine other.example login x password "keep"\nmachine smtp.example.com login backups@example.com password "old"\n');
    store('p@ss "word" \\ with spaces');
    store('p@ss "word" \\ with spaces');
    const netrc = path.join(home, ".nodeploy", "smtp.netrc");
    expect(fs.readFileSync(netrc, "utf-8")).toBe(
      'machine other.example login x password "keep"\nmachine smtp.example.com login backups@example.com password "p@ss \\"word\\" \\\\ with spaces"\n',
    );
    expect(fs.statSync(netrc).mode & 0o777).toBe(0o600);
  });
});

describe("nginx side", () => {
  it("every generated site includes the downloads snippet (a no-op until it exists)", () => {
    const http = buildServerBlock("hrms.example.com", 8080);
    expect(http.match(/include \/etc\/nginx\/snippets\/nodeploy-downloads\*\.conf;/g)).toHaveLength(1);
    const https = buildServerBlock("hrms.example.com", 8080, { ssl: true });
    const tls = https.slice(https.indexOf("ssl_certificate"));
    expect(tls).toContain("include /etc/nginx/snippets/nodeploy-downloads*.conf;");
    expect(https.match(/nodeploy-downloads/g)).toHaveLength(1); // not on the redirect-only port 80
  });

  it("writes a snippet that keeps nginx's variables and fills in the secret", () => {
    const setup = downloadSetupScript("hrms", download);
    const heredoc = /tee \/etc\/nginx\/snippets\/nodeploy-downloads\.conf >\/dev\/null <<NGINX\n([\s\S]*?)\nNGINX/.exec(setup)![1];
    const snippet = execFileSync("sh", ["-c", `cat <<NGINX\n${heredoc}\nNGINX`], { env: { ...process.env, SECRET: "abc123" }, encoding: "utf-8" });
    expect(snippet).toContain("location /nodeploy-backups/ {");
    expect(snippet).toContain("secure_link $arg_md5,$arg_expires;");
    expect(snippet).toContain('secure_link_md5 "$secure_link_expires$uri abc123";');
    expect(snippet).toContain('if ($secure_link = "") { return 403; }');
    expect(snippet).toContain('if ($secure_link = "0") { return 410; }');
    expect(snippet).toContain(`alias ${DOWNLOAD_ROOT}/;`);
    expect(setup).toContain("listen 8799;");
    expect(setup).toMatch(/nginx -t/);
  });
});

describe("email and download in nodeploy.yml", () => {
  const base = { service: "hrms", repo: "git@github.com:a/b.git", server: "192.168.0.8", ssh: { user: "root" } };
  const withSsl = { ...base, port: 8080, proxy: { host: "hrms.example.com", ssl: true } };

  it("applies defaults: port 587, from = smtp user; download on 8799, public when the app has HTTPS, 7 days", () => {
    const config = validateDeployConfig({
      ...withSsl,
      backup: { paths: ["d"], email: { to: "hr@example.com", smtp: { host: "smtp.example.com", user: "b@example.com" } }, download: true },
    });
    expect(config.backup?.email).toEqual({ to: ["hr@example.com"], from: "b@example.com", smtp: { host: "smtp.example.com", port: 587, user: "b@example.com" } });
    expect(config.backup?.download).toEqual({ lanPort: 8799, public: true, expiresDays: 7 });
    expect(validateDeployConfig({ ...base, backup: { paths: ["d"], download: true } }).backup?.download?.public).toBe(false);
  });

  it.each([
    [{ email: { to: "nope", smtp: { host: "h.example", user: "u" } } }, /email.to/],
    [{ email: { to: "a@b.co", smtp: { host: "h.example", user: "u", password: "x" } } }, /don't put the SMTP password in nodeploy.yml/],
    [{ email: { to: "a@b.co", smtp: { host: "h.example" } } }, /smtp.user/],
    [{ email: { to: "a@b.co", from: "Evil\r\nBcc: x@y.z", smtp: { host: "h.example", user: "u" } } }, /email.from/],
    [{ download: { lan_port: 80 } }, /lan_port/],
    [{ download: { public: true } }, /needs the app's own HTTPS site/],
    [{ download: { lan_port: false } }, /no link left/],
    [{ download: { expires: 90 } }, /expires/],
  ])("rejects %j", (extra, message) => {
    expect(() => validateDeployConfig({ ...base, backup: { paths: ["d"], ...extra } })).toThrow(message);
  });
});
