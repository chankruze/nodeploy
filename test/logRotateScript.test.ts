import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRotateScript,
  parseRotateOutput,
  type RotateOptions,
  type RotateTarget,
} from "../src/lib/logRotation.js";

// Runs the real rotate script with /bin/sh against real files. `pm2` is a
// stub on PATH: `pm2 reloadLogs` signals the writer processes to reopen
// their log paths, which is what PM2's daemon does for its apps.

let dir: string;
let bin: string;
const writers: ChildProcess[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nodeploy-rotate-"));
  bin = fs.mkdtempSync(path.join(os.tmpdir(), "nodeploy-rotate-bin-"));
  fs.writeFileSync(
    path.join(bin, "pm2"),
    [
      "#!/bin/sh",
      'echo "$@" >> "$FAKE_PM2_CALLS"',
      'if [ "$1" = reloadLogs ]; then',
      '  [ "${FAKE_PM2_FAIL:-0}" = 1 ] && exit 1',
      '  for pid in ${FAKE_WRITER_PIDS:-}; do kill -USR2 "$pid"; done',
      "  sleep 0.3",
      "fi",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
});

afterEach(() => {
  for (const w of writers.splice(0)) w.kill("SIGKILL");
  for (const d of [dir, bin]) {
    // Undo chmods from the permission test so cleanup works.
    execFileSync("chmod", ["-R", "u+rwx", d]);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function rotate(
  targets: RotateTarget[],
  opts: RotateOptions,
  env: Record<string, string> = {},
) {
  const stdout = execFileSync("sh", ["-s"], {
    input: buildRotateScript(targets, opts),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_PM2_CALLS: path.join(bin, "calls"),
      ...env,
    },
    encoding: "utf-8",
  });
  return parseRotateOutput(stdout);
}

function pm2Calls(): string[] {
  const file = path.join(bin, "calls");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim().split("\n") : [];
}

function log(name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

function readArchive(file: string): string {
  const data = fs.readFileSync(file);
  return file.endsWith(".gz") ? zlib.gunzipSync(data).toString() : data.toString();
}

function archivesOf(stem: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${stem}__`))
    .sort();
}

const ARCHIVE = /__\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log(\.gz)?$/;

describe("rotate script", () => {
  it("rotates out and err logs into gzip archives, keeping their content, and reopens them via pm2 reloadLogs", () => {
    const out = log("api-out.log", "hello out\n".repeat(1000));
    const err = log("api-error.log", "boom\n".repeat(1000));

    const result = rotate(
      [
        { path: out, mode: "move" },
        { path: err, mode: "move" },
      ],
      { compress: true, retain: 7 },
    );

    expect(result.errors).toEqual([]);
    expect(result.rotated.map((r) => r.log)).toEqual([out, err]);
    for (const r of result.rotated) {
      expect(r.archive).toMatch(ARCHIVE);
      expect(r.archive.endsWith(".gz")).toBe(true);
      expect(fs.existsSync(r.archive.replace(/\.gz$/, ""))).toBe(false);
    }
    expect(readArchive(result.rotated[0].archive)).toBe("hello out\n".repeat(1000));
    expect(readArchive(result.rotated[1].archive)).toBe("boom\n".repeat(1000));
    expect(pm2Calls()).toEqual(["reloadLogs"]);
  });

  it("keeps archives uncompressed when compress is off", () => {
    const out = log("api-out.log", "plain\n");
    const result = rotate([{ path: out, mode: "move" }], { compress: false, retain: 7 });
    expect(result.rotated[0].archive.endsWith(".log")).toBe(true);
    expect(readArchive(result.rotated[0].archive)).toBe("plain\n");
  });

  it("keeps only the newest `retain` archives, and leaves other apps' archives alone", () => {
    for (let day = 1; day <= 9; day++) {
      log(`api-out__2026-11-0${day}_00-00-00.log.gz`, "old");
    }
    log("my-api-out__2026-11-01_00-00-00.log.gz", "other app");
    log("api-error__2026-11-01_00-00-00.log.gz", "same app, other stream");
    const out = log("api-out.log", "new\n");

    const result = rotate([{ path: out, mode: "move" }], { compress: true, retain: 7 });

    const kept = archivesOf("api-out");
    expect(kept).toHaveLength(7);
    expect(kept).toContain(path.basename(result.rotated[0].archive));
    // Oldest go first.
    expect(kept).not.toContain("api-out__2026-11-01_00-00-00.log.gz");
    expect(kept).not.toContain("api-out__2026-11-03_00-00-00.log.gz");
    expect(kept).toContain("api-out__2026-11-04_00-00-00.log.gz");
    expect(result.deleted).toHaveLength(3);
    expect(archivesOf("my-api-out")).toHaveLength(1);
    expect(archivesOf("api-error")).toHaveLength(1);
  });

  it("skips missing and empty logs, and still rotates the rest", () => {
    const missing = path.join(dir, "gone-out.log");
    const empty = log("idle-out.log", "");
    const out = log("api-out.log", "data\n");

    const result = rotate(
      [
        { path: missing, mode: "move" },
        { path: empty, mode: "move" },
        { path: out, mode: "move" },
      ],
      { compress: true, retain: 7 },
    );

    expect(result.skipped).toEqual([
      { log: missing, reason: "missing" },
      { log: empty, reason: "empty" },
    ]);
    expect(result.rotated.map((r) => r.log)).toEqual([out]);
    expect(fs.existsSync(empty)).toBe(true);
  });

  it("does not call pm2 at all when there's nothing to rotate", () => {
    const result = rotate([{ path: log("idle-out.log", ""), mode: "move" }], {
      compress: true,
      retain: 7,
    });
    expect(result.rotated).toEqual([]);
    expect(pm2Calls()).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports a permission error for one log and carries on with the others",
    () => {
      const locked = path.join(dir, "locked");
      fs.mkdirSync(locked);
      const lockedLog = path.join(locked, "root-out.log");
      fs.writeFileSync(lockedLog, "can't move me\n");
      fs.chmodSync(locked, 0o555);
      const out = log("api-out.log", "data\n");

      const result = rotate(
        [
          { path: lockedLog, mode: "move" },
          { path: out, mode: "move" },
        ],
        { compress: true, retain: 7 },
      );

      expect(result.errors.map((e) => e.log)).toEqual([lockedLog]);
      expect(fs.readFileSync(lockedLog, "utf-8")).toBe("can't move me\n");
      expect(result.rotated.map((r) => r.log)).toEqual([out]);
    },
  );

  it("puts logs back untouched if pm2 reloadLogs fails, and deletes nothing", () => {
    log("api-out__2026-11-01_00-00-00.log.gz", "old");
    const out = log("api-out.log", "keep me\n");

    const result = rotate([{ path: out, mode: "move" }], { compress: true, retain: 1 }, {
      FAKE_PM2_FAIL: "1",
    });

    expect(result.rotated).toEqual([]);
    expect(result.errors[0].message).toMatch(/reloadLogs failed/);
    expect(fs.readFileSync(out, "utf-8")).toBe("keep me\n");
    expect(archivesOf("api-out")).toEqual(["api-out__2026-11-01_00-00-00.log.gz"]);
  });

  it("copy mode (pm2.log) archives then truncates in place", () => {
    const pm2log = log("pm2.log", "daemon line\n".repeat(50));
    const result = rotate([{ path: pm2log, mode: "copy" }], { compress: true, retain: 7 });

    expect(result.errors).toEqual([]);
    expect(readArchive(result.rotated[0].archive)).toBe("daemon line\n".repeat(50));
    expect(fs.statSync(pm2log).size).toBe(0);
    expect(pm2Calls()).toEqual([]);
  });

  it("loses no lines from an app writing continuously during rotation", async () => {
    const out = path.join(dir, "busy-out.log");
    const done = path.join(dir, "writer-done");
    // Holds the log open like PM2 does, and reopens it on SIGUSR2 like
    // PM2's reloadLogs. Writes numbered lines as fast as it can.
    const writerSource = `
      const fs = require("fs");
      const [file, doneFile] = process.argv.slice(1);
      let fd = fs.openSync(file, "a");
      let i = 0;
      process.on("SIGUSR2", () => { const old = fd; fd = fs.openSync(file, "a"); fs.closeSync(old); });
      process.on("SIGTERM", () => { fs.writeFileSync(doneFile, String(i)); process.exit(0); });
      const tick = () => { for (let n = 0; n < 50; n++) fs.writeSync(fd, "line " + (i++) + "\\n"); setImmediate(tick); };
      tick();
    `;
    const writer = spawn(process.execPath, ["-e", writerSource, out, done], {
      stdio: "ignore",
    });
    writers.push(writer);
    await waitFor(() => fs.existsSync(out) && fs.statSync(out).size > 200_000);

    const result = rotate([{ path: out, mode: "move" }], { compress: true, retain: 7 }, {
      FAKE_WRITER_PIDS: String(writer.pid),
    });
    expect(result.errors).toEqual([]);
    expect(result.rotated).toHaveLength(1);

    // Keep writing into the reopened file for a moment, then stop.
    await waitFor(() => fs.existsSync(out) && fs.statSync(out).size > 50_000);
    writer.kill("SIGTERM");
    await waitFor(() => fs.existsSync(done));
    const written = Number(fs.readFileSync(done, "utf-8"));

    const lines = (readArchive(result.rotated[0].archive) + fs.readFileSync(out, "utf-8"))
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBe(written);
    lines.forEach((line, n) => expect(line).toBe(`line ${n}`));
  }, 20_000);
});

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
