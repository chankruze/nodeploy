import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseProbe, planLogRotation, probeScript } from "../src/lib/logRotation.js";

// Runs the real probe script with /bin/sh against a fake PM2 home. PM2 (and
// nodeploy) write module_conf.json without a trailing newline; on a real
// server that glued the next section marker onto its last line, so a fully
// set-up server read as "not installed" and was reconfigured on every run.

let home: string;
let bin: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nodeploy-probe-home-"));
  bin = fs.mkdtempSync(path.join(os.tmpdir(), "nodeploy-probe-bin-"));
  const pkgDir = path.join(home, "modules/pm2-logrotate/node_modules/pm2-logrotate");
  fs.mkdirSync(pkgDir, { recursive: true });
  // No trailing newlines, exactly as found on the server.
  fs.writeFileSync(
    path.join(home, "module_conf.json"),
    JSON.stringify(
      {
        "pm2-logrotate": {
          max_size: "50M",
          retain: "7",
          compress: true,
          workerInterval: "30",
          rotateModule: true,
          dateFormat: "YYYY-MM-DD_HH-mm-ss",
          rotateInterval: "0 0 * * *",
        },
        "module-db-v2": { "pm2-logrotate": {} },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "pm2-logrotate", version: "3.0.1" }, null, 2),
  );
  const jlist = JSON.stringify([
    { name: "hrms", pm2_env: { status: "online", pm_out_log_path: `${home}/logs/hrms-out.log` } },
    { name: "pm2-logrotate", pm2_env: { status: "online", pmx_module: true } },
  ]);
  fs.writeFileSync(path.join(bin, "pm2"), `#!/bin/sh\nprintf '%s' '${jlist}'\n`, {
    mode: 0o755,
  });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(bin, { recursive: true, force: true });
});

function probe(): string {
  return execFileSync("sh", ["-s"], {
    input: probeScript(),
    env: { ...process.env, PM2_HOME: home, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf-8",
  });
}

describe("probe script", () => {
  it("reads every section even when files don't end in a newline", () => {
    const state = parseProbe(probe());
    expect(state.pm2Home).toBe(home);
    expect(state.installed).toBe(true);
    expect(state.version).toBe("3.0.1");
    expect(state.moduleStatus).toBe("online");
    expect(state.settings.max_size).toBe("50M");
    expect(state.processes.map((p) => p.name)).toEqual(["hrms", "pm2-logrotate"]);
  });

  it("plans nothing for a server that is already set up", () => {
    const plan = planLogRotation(parseProbe(probe()));
    expect(plan.action).toBe("none");
    expect(plan.changed).toEqual([]);
  });
});
