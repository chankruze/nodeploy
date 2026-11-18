import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authorizeKeyScript,
  buildBackupScript,
  buildRestoreScript,
  cronLine,
  parseBackupListing,
  parseBackupOutput,
  parseRestoreOutput,
  setupScript,
} from "../src/lib/backup.js";

// Runs the real backup/restore scripts with /bin/sh against real files and
// real SQLite databases, in a throwaway $HOME. `crontab` is a stub that
// keeps the "crontab" in a file.

const hasSqlite = (() => {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let home: string;
let app: string;
let bin: string;
let dest: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nodeploy-backup-home-"));
  bin = fs.mkdtempSync(path.join(os.tmpdir(), "nodeploy-backup-bin-"));
  app = path.join(home, "apps", "arap");
  dest = path.join(home, ".nodeploy", "backups", "arap");
  fs.mkdirSync(path.join(app, "data", "uploads"), { recursive: true });
  fs.writeFileSync(path.join(app, "data", "uploads", "logo.txt"), "logo bytes\n");
  fs.writeFileSync(path.join(app, "notes.json"), '{"v":1}\n');
  fs.writeFileSync(
    path.join(bin, "crontab"),
    `#!/bin/sh\nf="${path.join(bin, "crontab.txt")}"\nif [ "$1" = "-l" ]; then [ -f "$f" ] && cat "$f" || exit 1; else cat > "$f"; fi\n`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(bin, { recursive: true, force: true });
});

function sh(script: string, args: string[] = [], allowFail = false): { out: string; code: number } {
  try {
    const out = execFileSync("sh", ["-s", ...args], {
      input: script,
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf-8",
    });
    return { out, code: 0 };
  } catch (error) {
    if (!allowFail) throw error;
    const e = error as { stdout?: string; status?: number };
    return { out: e.stdout ?? "", code: e.status ?? 1 };
  }
}

function script(paths: string[], keep = 14): string {
  return buildBackupScript({
    service: "arap",
    deployPath: "$HOME/apps/arap",
    paths,
    keep,
    nodeployVersion: "test",
  });
}

function sqlite(db: string, sql: string): string {
  return execFileSync("sqlite3", [db, sql], { encoding: "utf-8" }).trim();
}

function archives(): string[] {
  return fs.existsSync(dest) ? fs.readdirSync(dest).filter((f) => f.endsWith(".tar.gz")).sort() : [];
}

function extract(archive: string): string {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nodeploy-backup-x-"));
  execFileSync("tar", ["-xzf", archive, "-C", out]);
  return out;
}

const pause = () => new Promise((r) => setTimeout(r, 1100)); // archive names are per-second

describe("backup script", () => {
  it("archives files and directories with a manifest and checksums, and reports missing paths", () => {
    const result = parseBackupOutput(sh(script(["data", "notes.json", "gone.txt"]), ["manual"]).out);

    expect(result.error).toBeNull();
    expect(result.missing).toEqual(["gone.txt"]);
    expect(result.archive).toMatch(/\/\.nodeploy\/backups\/arap\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_manual\.tar\.gz$/);
    expect(result.bytes).toBeGreaterThan(0);

    const x = extract(result.archive!);
    expect(fs.readFileSync(path.join(x, "files/notes.json"), "utf-8")).toBe('{"v":1}\n');
    expect(fs.readFileSync(path.join(x, "files/data/uploads/logo.txt"), "utf-8")).toBe("logo bytes\n");
    const manifest = fs.readFileSync(path.join(x, "MANIFEST"), "utf-8");
    expect(manifest).toContain("service=arap");
    expect(manifest).toContain("reason=manual");
    expect(manifest).toContain("path=data\npath=notes.json\npath=gone.txt");
    expect(fs.readFileSync(path.join(x, "SHA256SUMS"), "utf-8")).toMatch(/notes\.json/);
    fs.rmSync(x, { recursive: true });
  });

  it.runIf(hasSqlite)("snapshots a live WAL-mode SQLite database consistently, including uncheckpointed writes", async () => {
    const db = path.join(app, "data", "app.db");
    // An "app" holding the database open, its last writes not yet
    // checkpointed into the main file — as with a running server.
    const holder = spawn("sqlite3", [db], { stdio: ["pipe", "ignore", "ignore"] });
    holder.stdin.write("pragma journal_mode=wal; pragma wal_autocheckpoint=0; create table t(x); insert into t values (1),(2),(3);\n");
    const deadline = Date.now() + 5000;
    while (!(fs.existsSync(`${db}-wal`) && fs.statSync(`${db}-wal`).size > 0)) {
      if (Date.now() > deadline) throw new Error("no WAL appeared");
      await new Promise((r) => setTimeout(r, 20));
    }

    const result = parseBackupOutput(sh(script(["data"]), ["scheduled"]).out);
    holder.stdin.end();
    holder.kill();
    const x = extract(result.archive!);
    const copy = path.join(x, "files/data/app.db");
    expect(sqlite(copy, "pragma integrity_check; select count(*) from t;")).toBe("ok\n3");
    expect(fs.existsSync(`${copy}-wal`)).toBe(false);
    fs.rmSync(x, { recursive: true });
  });

  it("keeps only the newest `keep` backups", async () => {
    for (let i = 0; i < 3; i++) {
      const out = parseBackupOutput(sh(script(["notes.json"], 2), ["manual"]).out);
      if (i === 2) expect(out.pruned).toHaveLength(1);
      if (i < 2) await pause();
    }
    expect(archives()).toHaveLength(2);
  });

  it("never runs twice at once, but takes over a lock left by a run that died", () => {
    fs.mkdirSync(path.join(dest, ".lock"), { recursive: true });
    fs.writeFileSync(path.join(dest, ".lock", "pid"), String(process.pid)); // alive
    const busy = sh(script(["notes.json"]), ["manual"], true);
    expect(busy.code).toBe(3);
    expect(parseBackupOutput(busy.out).error).toMatch(/another backup/);

    fs.writeFileSync(path.join(dest, ".lock", "pid"), "999999"); // dead
    expect(parseBackupOutput(sh(script(["notes.json"]), ["manual"]).out).archive).not.toBeNull();
  });

  it("fails clearly, writing nothing, when the app directory is gone", () => {
    fs.rmSync(app, { recursive: true });
    const run = sh(script(["data"]), ["manual"], true);
    expect(run.code).not.toBe(0);
    expect(parseBackupOutput(run.out).error).toMatch(/app directory .* not found/);
    expect(archives()).toEqual([]);
  });
});

describe("restore script", () => {
  it.runIf(hasSqlite)("puts files back exactly, and drops a restored database's stale WAL", () => {
    const db = path.join(app, "data", "app.db");
    sqlite(db, "create table t(x); insert into t values (1),(2),(3);");
    const archive = parseBackupOutput(sh(script(["data", "notes.json"]), ["manual"]).out).archive!;

    // Things go wrong after the backup.
    sqlite(db, "delete from t;");
    fs.writeFileSync(path.join(app, "notes.json"), '{"v":"broken"}\n');
    fs.rmSync(path.join(app, "data", "uploads", "logo.txt"));
    fs.writeFileSync(`${db}-wal`, "stale wal from the broken state");

    const result = parseRestoreOutput(sh(buildRestoreScript("$HOME/apps/arap", archive)).out);
    expect(result.error).toBeNull();
    expect(result.restored).toEqual(["data", "notes.json"]);
    expect(sqlite(db, "pragma integrity_check; select count(*) from t;")).toBe("ok\n3");
    expect(fs.existsSync(`${db}-wal`)).toBe(false);
    expect(fs.readFileSync(path.join(app, "notes.json"), "utf-8")).toBe('{"v":1}\n');
    expect(fs.readFileSync(path.join(app, "data", "uploads", "logo.txt"), "utf-8")).toBe("logo bytes\n");
    expect(fs.readdirSync(app).some((f) => f.includes("nodeploy-"))).toBe(false);
  });

  it("refuses a damaged archive and leaves the app's files alone", () => {
    const archive = parseBackupOutput(sh(script(["notes.json"]), ["manual"]).out).archive!;
    fs.writeFileSync(path.join(app, "notes.json"), '{"v":2}\n');
    const bytes = fs.readFileSync(archive);
    fs.writeFileSync(archive, bytes.subarray(0, Math.floor(bytes.length / 2)));

    const run = sh(buildRestoreScript("$HOME/apps/arap", archive), [], true);
    expect(run.code).not.toBe(0);
    expect(parseRestoreOutput(run.out).error).toMatch(/damaged/);
    expect(fs.readFileSync(path.join(app, "notes.json"), "utf-8")).toBe('{"v":2}\n');
  });

  it("refuses an archive whose files don't match their checksums", () => {
    const archive = parseBackupOutput(sh(script(["notes.json"]), ["manual"]).out).archive!;
    const x = extract(archive);
    fs.writeFileSync(path.join(x, "files/notes.json"), '{"tampered":true}\n');
    execFileSync("tar", ["-czf", archive, "-C", x, "MANIFEST", "SHA256SUMS", "files"]);
    fs.rmSync(x, { recursive: true });

    const run = sh(buildRestoreScript("$HOME/apps/arap", archive), [], true);
    expect(parseRestoreOutput(run.out).error).toMatch(/checksums do not match/);
    expect(fs.readFileSync(path.join(app, "notes.json"), "utf-8")).toBe('{"v":1}\n');
  });
});

describe("setup script", () => {
  const crontab = () => fs.readFileSync(path.join(bin, "crontab.txt"), "utf-8");

  it("installs the script and one cron line per app, keeping the rest of the crontab", () => {
    fs.writeFileSync(path.join(bin, "crontab.txt"), "0 5 * * * /usr/bin/other-job\n");
    const s = script(["notes.json"]);
    sh(setupScript({ service: "arap", script: s, schedule: "daily" }));
    sh(setupScript({ service: "arap", script: s, schedule: "daily" })); // idempotent

    const lines = crontab().trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("0 5 * * * /usr/bin/other-job");
    expect(lines[1]).toBe(cronLine("arap", "daily"));
    expect(lines[1]).toMatch(/^\d+ 2 \* \* \* \/bin\/sh "\$HOME\/\.nodeploy\/backup-arap\.sh" scheduled/);

    // The installed script works on its own.
    const installed = path.join(home, ".nodeploy", "backup-arap.sh");
    expect(fs.statSync(installed).mode & 0o777).toBe(0o700);
    const out = execFileSync("sh", [installed, "scheduled"], { env: { ...process.env, HOME: home }, encoding: "utf-8" });
    expect(parseBackupOutput(out).archive).toMatch(/_scheduled\.tar\.gz$/);
  });

  it("changes the schedule in place, and removes the line for schedule: off", () => {
    const s = script(["notes.json"]);
    sh(setupScript({ service: "arap", script: s, schedule: "daily" }));
    sh(setupScript({ service: "hrms", script: s, schedule: "hourly" }));
    sh(setupScript({ service: "arap", script: s, schedule: "30 1 * * *" }));
    expect(crontab()).toContain('30 1 * * * /bin/sh "$HOME/.nodeploy/backup-arap.sh"');
    expect(crontab().match(/nodeploy:backup:arap/g)).toHaveLength(1);

    sh(setupScript({ service: "arap", script: s, schedule: "off" }));
    expect(crontab()).not.toContain("nodeploy:backup:arap");
    expect(crontab()).toContain("nodeploy:backup:hrms");
  });
});

describe("parseBackupListing", () => {
  it("lists archives newest first and ignores everything else", () => {
    const { entries, cron } = parseBackupListing(
      [
        "total 12",
        "-rw------- 1 0 0 5120 Nov 17 02:17 2026-11-17_02-17-00_scheduled.tar.gz",
        "-rw------- 1 0 0 6144 Nov 17 11:40 2026-11-17_11-40-02_pre-deploy.tar.gz",
        "-rw------- 1 0 0 100 Nov 17 11:41 2026-11-17_11-41-00_manual.tar.gz.part",
        "-rw------- 1 0 0 900 Nov 17 11:41 backup.log",
        "CRON\t17 2 * * * /bin/sh ... # nodeploy:backup:arap",
      ].join("\n"),
      "/root/.nodeploy/backups/arap",
    );
    expect(entries.map((e) => e.reason)).toEqual(["pre-deploy", "scheduled"]);
    expect(entries[0]).toMatchObject({
      created: "2026-11-17 11:40:02",
      bytes: 6144,
      path: "/root/.nodeploy/backups/arap/2026-11-17_11-40-02_pre-deploy.tar.gz",
    });
    expect(cron).toContain("nodeploy:backup:arap");
  });
});

describe("copy to a second server", () => {
  let remote: string;
  const copyTo = { server: "192.168.0.12", ssh: { user: "backup", port: 2222 }, path: "nodeploy-backups", keep: 2 };

  beforeEach(() => {
    remote = fs.mkdtempSync(path.join(os.tmpdir(), "nodeploy-backup-remote-"));
    // ssh/scp stubs: the "remote" is a local directory. They check the
    // target and port they're given, and fail on demand.
    const parse = `
target=""; port=""; args=""
while [ $# -gt 0 ]; do
  case "$1" in
    -i|-o) shift 2 ;;
    -p|-P) port=$2; shift 2 ;;
    -q) shift ;;
    *) args="$args
$1"; shift ;;
  esac
done
[ "\${FAKE_COPY_FAIL:-0}" = 1 ] && exit 255
[ "$port" = 2222 ] || { echo "wrong port $port" >&2; exit 254; }`;
    fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\n${parse}\ntarget=$(printf '%s\\n' "$args" | sed -n 2p); cmd=$(printf '%s\\n' "$args" | sed -n '3,$p')\n[ "$target" = backup@192.168.0.12 ] || exit 253\ncd "${remote}" && sh -c "$cmd"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "scp"), `#!/bin/sh\n${parse}\nsrc=$(printf '%s\\n' "$args" | sed -n 2p); dst=$(printf '%s\\n' "$args" | sed -n 3p)\ncase "$dst" in backup@192.168.0.12:*) cp "$src" "${remote}/\${dst#*:}" ;; *) exit 253 ;; esac\n`, { mode: 0o755 });
  });

  afterEach(() => fs.rmSync(remote, { recursive: true, force: true }));

  const copyScript = () =>
    buildBackupScript({ service: "arap", deployPath: "$HOME/apps/arap", paths: ["notes.json"], keep: 14, nodeployVersion: "test", copyTo });
  const remoteArchives = () => fs.readdirSync(path.join(remote, "nodeploy-backups", "arap")).sort();

  it("copies each backup there atomically and keeps copy_to.keep copies", async () => {
    for (let i = 0; i < 3; i++) {
      const out = parseBackupOutput(sh(copyScript(), ["scheduled"]).out);
      expect(out.copyError).toBeNull();
      expect(out.copied).toMatch(/^backup@192\.168\.0\.12:nodeploy-backups\/arap\/.*_scheduled\.tar\.gz$/);
      if (i < 2) await pause();
    }
    const copies = remoteArchives();
    expect(copies).toHaveLength(2);
    expect(copies.some((f) => f.endsWith(".part"))).toBe(false);
    // Byte-identical to the newest local backup.
    const newest = archives().at(-1)!;
    expect(fs.readFileSync(path.join(remote, "nodeploy-backups", "arap", newest))).toEqual(fs.readFileSync(path.join(dest, newest)));
    expect(archives()).toHaveLength(3); // local keep (14) is separate
  });

  it("reports a failed copy without failing the backup", () => {
    const run = sh(copyScript(), ["scheduled"]);
    expect(run.code).toBe(0);
    process.env.FAKE_COPY_FAIL = "1";
    try {
      const out = parseBackupOutput(sh(copyScript(), ["manual"]).out);
      expect(out.archive).not.toBeNull();
      expect(out.error).toBeNull();
      expect(out.copied).toBeNull();
      expect(out.copyError).toMatch(/could not copy the backup to backup@192\.168\.0\.12:nodeploy-backups\/arap/);
    } finally {
      delete process.env.FAKE_COPY_FAIL;
    }
  });
});

describe("authorizeKeyScript", () => {
  it("authorizes the copy key once, restricted, and creates the directory", () => {
    const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBody nodeploy-backups@beepl1";
    const authorized = path.join(home, ".ssh", "authorized_keys");
    fs.mkdirSync(path.dirname(authorized), { recursive: true });
    fs.writeFileSync(authorized, "ssh-ed25519 AAAAexisting someone@laptop\n");
    sh(authorizeKeyScript(key, "nodeploy-backups/arap"));
    sh(authorizeKeyScript(key, "nodeploy-backups/arap"));
    expect(fs.readFileSync(authorized, "utf-8")).toBe(`ssh-ed25519 AAAAexisting someone@laptop\nrestrict ${key}\n`);
    expect(fs.statSync(path.join(home, "nodeploy-backups", "arap")).isDirectory()).toBe(true);
  });
});
