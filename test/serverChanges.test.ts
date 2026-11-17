import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupScript,
  conflicting,
  guardMessage,
  inspectScript,
  keepSyncScript,
  parseInspect,
} from "../src/lib/serverChanges.js";

// Real git, real files: a bare "origin", a developer clone that pushes new
// commits, and the "server" checkout nodeploy deploys into, where the app
// changes files at runtime.

let tmp: string;
let origin: string;
let dev: string;
let server: string;

// Hermetic git: ignore the developer's global/system config (e.g. commit
// signing, hooks) and never sign the test repos' commits.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "tag.gpgsign",
  GIT_CONFIG_VALUE_1: "false",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf-8" }).trim();
}

function write(dir: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

function read(dir: string, file: string): string {
  return fs.readFileSync(path.join(dir, file), "utf-8");
}

function run(script: string): string {
  return execFileSync("sh", ["-s"], { input: script, env: GIT_ENV, encoding: "utf-8" });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nodeploy-guard-"));
  origin = path.join(tmp, "origin.git");
  dev = path.join(tmp, "dev");
  server = path.join(tmp, "server");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: GIT_ENV });
  execFileSync("git", ["clone", "-q", origin, dev], { env: GIT_ENV });
  git(dev, "checkout", "-q", "-b", "main");
  write(dev, "server.js", "v1 code\n");
  write(dev, "data/app.db", "committed data\n");
  write(dev, "gone.json", "committed store\n");
  write(dev, "same.txt", "old\n");
  git(dev, "add", ".");
  git(dev, "commit", "-q", "-m", "initial");
  git(dev, "push", "-q", "origin", "main");
  execFileSync("git", ["clone", "-q", "--branch", "main", origin, server], { env: GIT_ENV });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The app writes at runtime on the server; meanwhile a new commit lands. */
function divergeServerAndOrigin(): void {
  write(server, "data/app.db", "committed data\nruntime rows written on the server\n");
  write(server, "gone.json", "committed store\nruntime entries\n");
  write(server, "same.txt", "new\n");
  write(server, "uploads/logo.txt", "uploaded on the server\n");

  write(dev, "server.js", "v2 code\n");
  write(dev, "data/app.db", "a different committed version\n");
  git(dev, "rm", "-q", "gone.json");
  write(dev, "same.txt", "new\n");
  write(dev, "uploads/logo.txt", "placeholder from the repo\n");
  git(dev, "add", ".");
  git(dev, "commit", "-q", "-m", "v2");
  git(dev, "push", "-q", "origin", "main");
}

describe("inspectScript", () => {
  it("reports what the reset would do to each file the server changed", () => {
    divergeServerAndOrigin();
    const result = parseInspect(run(inspectScript(server, "main")))!;

    expect(result.head).toMatch(/^[0-9a-f]{40}$/);
    expect(result.target).toBe(git(dev, "rev-parse", "HEAD"));
    const byPath = Object.fromEntries(result.changes.map((c) => [c.path, c]));
    expect(byPath["data/app.db"]).toEqual({ path: "data/app.db", kind: "overwritten", tracked: true });
    expect(byPath["gone.json"]).toEqual({ path: "gone.json", kind: "deleted", tracked: true });
    expect(byPath["uploads/logo.txt"]).toEqual({ path: "uploads/logo.txt", kind: "overwritten", tracked: false });
    // Changed on the server, but identical to the new commit: nothing lost.
    expect(byPath["same.txt"]).toEqual({ path: "same.txt", kind: "same", tracked: true });
    expect(conflicting(result.changes).map((c) => c.path).sort()).toEqual([
      "data/app.db",
      "gone.json",
      "uploads/logo.txt",
    ]);
  });

  it("finds nothing when the server hasn't changed anything", () => {
    write(dev, "server.js", "v2 code\n");
    git(dev, "commit", "-q", "-am", "v2");
    git(dev, "push", "-q", "origin", "main");
    expect(parseInspect(run(inspectScript(server, "main")))!.changes).toEqual([]);
  });

  it("catches changes even when redeploying the same commit (reset --hard still reverts them)", () => {
    write(server, "data/app.db", "committed data\nruntime\n");
    const result = parseInspect(run(inspectScript(server, "main")))!;
    expect(result.head).toBe(result.target);
    expect(result.changes).toEqual([{ path: "data/app.db", kind: "overwritten", tracked: true }]);
  });

  it("says NOREPO before the first deploy", () => {
    expect(parseInspect(run(inspectScript(path.join(tmp, "nothing-here"), "main")))).toBeNull();
  });

  it("handles paths with spaces", () => {
    write(dev, "data/company logo.txt", "a\n");
    git(dev, "add", ".");
    git(dev, "commit", "-q", "-m", "logo");
    git(dev, "push", "-q", "origin", "main");
    git(server, "pull", "-q", "origin", "main");
    write(server, "data/company logo.txt", "changed\n");
    const result = parseInspect(run(inspectScript(server, "main")))!;
    expect(result.changes).toEqual([{ path: "data/company logo.txt", kind: "overwritten", tracked: true }]);
  });
});

describe("plain sync (what --overwrite-server-files does)", () => {
  it("loses the server's runtime data — which is why deploy stops first", () => {
    divergeServerAndOrigin();
    git(server, "fetch", "-q", "origin", "main");
    git(server, "reset", "-q", "--hard", "origin/main");
    expect(read(server, "data/app.db")).toBe("a different committed version\n");
    expect(fs.existsSync(path.join(server, "gone.json"))).toBe(false);
  });
});

describe("keepSyncScript (--keep-server-files)", () => {
  it("deploys the new code while keeping every server copy, and loses no writes from an app holding a file open", () => {
    divergeServerAndOrigin();
    const changes = conflicting(parseInspect(run(inspectScript(server, "main")))!.changes);

    // The running app has its database open, as SQLite would.
    const fd = fs.openSync(path.join(server, "data/app.db"), "a");
    fs.writeSync(fd, "written just before the sync\n");

    run(keepSyncScript(server, "main", changes));

    // Still the same file: the app's next write lands in the kept copy.
    fs.writeSync(fd, "written after the sync\n");
    fs.closeSync(fd);

    expect(git(server, "rev-parse", "HEAD")).toBe(git(dev, "rev-parse", "HEAD"));
    expect(read(server, "server.js")).toBe("v2 code\n");
    expect(read(server, "data/app.db")).toBe(
      "committed data\nruntime rows written on the server\nwritten just before the sync\nwritten after the sync\n",
    );
    // Dropped from the repo, so it's simply untracked now, content intact.
    expect(read(server, "gone.json")).toBe("committed store\nruntime entries\n");
    expect(git(server, "ls-files", "gone.json")).toBe("");
    expect(read(server, "uploads/logo.txt")).toBe("uploaded on the server\n");
    expect(fs.existsSync(path.join(server, ".git/nodeploy-keep"))).toBe(false);
  });

  it("puts every file back even if the reset fails", () => {
    divergeServerAndOrigin();
    const changes = conflicting(parseInspect(run(inspectScript(server, "main")))!.changes);
    const script = keepSyncScript(server, "main", changes).replace(
      /git reset --hard '[^']+'/,
      "git reset --hard origin/no-such-branch",
    );
    expect(() => run(script)).toThrow();
    expect(read(server, "data/app.db")).toBe("committed data\nruntime rows written on the server\n");
    expect(read(server, "uploads/logo.txt")).toBe("uploaded on the server\n");
  });
});

describe("backupScript", () => {
  it("copies the files into .git/nodeploy-backups/<time>/, out of git's reach", () => {
    divergeServerAndOrigin();
    const out = run(backupScript(server, ["data/app.db", "gone.json"]));
    const dir = out.split("\n").find((l) => l.startsWith("BACKUP\t"))!.slice(7);
    expect(dir).toMatch(/\.git\/nodeploy-backups\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
    expect(read(dir, "data/app.db")).toBe(read(server, "data/app.db"));
    expect(read(dir, "gone.json")).toBe(read(server, "gone.json"));
  });

  it.runIf(
    (() => {
      try {
        execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })(),
  )("backs up SQLite databases with sqlite3's online backup", () => {
    const db = path.join(server, "data/live.db");
    execFileSync("sqlite3", [db, "create table t(x); insert into t values (1),(2),(3);"]);
    const out = run(backupScript(server, ["data/live.db"]));
    const dir = out.split("\n").find((l) => l.startsWith("BACKUP\t"))!.slice(7);
    const copy = path.join(dir, "data/live.db");
    expect(execFileSync("sqlite3", [copy, "pragma integrity_check; select count(*) from t;"], { encoding: "utf-8" }).trim()).toBe("ok\n3");
  });
});

describe("guardMessage", () => {
  it("lists each file with what would happen, and the ways forward", () => {
    const lines = guardMessage("arap", [
      { path: "data/brothers_project_accounts.db", kind: "overwritten", tracked: true },
      { path: "hrms-data.json", kind: "deleted", tracked: true },
    ]);
    const text = lines.join("\n");
    expect(lines[0]).toMatch(/Deploying arap would change 2 file\(s\).*nothing was touched/);
    expect(text).toMatch(/brothers_project_accounts\.db .*it would be overwritten/);
    expect(text).toMatch(/hrms-data\.json .*it would be deleted/);
    expect(text).toContain("--keep-server-files");
    expect(text).toContain("--overwrite-server-files");
    expect(text).toContain("nodeploy pull-files");
    expect(text).toContain("git rm --cached");
  });
});
