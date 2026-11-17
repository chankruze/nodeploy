import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const {
  LOGROTATE_VERSION,
  archiveSource,
  describeEnsureResult,
  ensureLogRotation,
  firstPassWarnings,
  isValidMaxSize,
  liveLogPaths,
  logUsageWarnings,
  parseListing,
  parseMaxSize,
  parseProbe,
  parseRotateOutput,
  planLogRotation,
  readServerSettings,
  resolveLogRotation,
  summarizeLogUsage,
} = await import("../src/lib/logRotation.js");
const { withNvm } = await import("../src/lib/remoteEnv.js");

const target: SSHTarget = { host: "192.168.0.12", user: "deploy", port: 22 };
const HOME = "/home/deploy/.pm2";
const S = "__NODEPLOY_SECTION__";

/** The nodeploy defaults, as written to module_conf.json. */
const DESIRED_CONF = {
  max_size: "50M",
  retain: "7",
  compress: true,
  workerInterval: "30",
  rotateModule: true,
  dateFormat: "YYYY-MM-DD_HH-mm-ss",
};

function jlistApp(name: string, opts: { status?: string; module?: boolean } = {}) {
  return {
    name,
    pm2_env: {
      status: opts.status ?? "online",
      pmx_module: opts.module ?? false,
      pm_out_log_path: `${HOME}/logs/${name}-out.log`,
      pm_err_log_path: `${HOME}/logs/${name}-error.log`,
      pm_log_path: undefined,
    },
  };
}

function probeOutput(
  opts: {
    installed?: boolean;
    settings?: Record<string, unknown>;
    version?: string | null;
    moduleStatus?: string | null;
    daemons?: string[];
    apps?: string[];
    banner?: boolean;
  } = {},
): string {
  const conf: Record<string, unknown> = {};
  if (opts.installed) conf["module-db-v2"] = { "pm2-logrotate": {} };
  if (opts.settings) conf["pm2-logrotate"] = opts.settings;
  const jlist = (opts.apps ?? ["api"]).map((name) => jlistApp(name));
  if (opts.moduleStatus) {
    jlist.push(jlistApp("pm2-logrotate", { status: opts.moduleStatus, module: true }));
  }
  return [
    `${S} home`,
    HOME,
    `${S} conf`,
    Object.keys(conf).length > 0 ? JSON.stringify(conf, null, 4) : "",
    `${S} package`,
    opts.version ? JSON.stringify({ name: "pm2-logrotate", version: opts.version }) : "",
    `${S} daemons`,
    ...(opts.daemons ?? [`deploy   PM2 v6.0.8: God Daemon (${HOME})`]),
    `${S} jlist`,
    ...(opts.banner ? ["[PM2] Spawning PM2 daemon with pm2_home=" + HOME] : []),
    JSON.stringify(jlist),
  ].join("\n");
}

/** A server where nodeploy already set everything up. */
const UP_TO_DATE = {
  installed: true,
  settings: DESIRED_CONF,
  version: LOGROTATE_VERSION,
  moduleStatus: "online",
};

function remoteCommand(call: number): string {
  const args = execa.mock.calls[call][1] as string[];
  return args[args.length - 1];
}

describe("sizes", () => {
  it("parses pm2-logrotate sizes", () => {
    expect(parseMaxSize("50M")).toBe(50 * 1024 * 1024);
    expect(parseMaxSize("1G")).toBe(1024 ** 3);
    expect(parseMaxSize("500k")).toBe(500 * 1024);
    expect(parseMaxSize("2048")).toBe(2048);
    expect(parseMaxSize("50MB")).toBeNull();
    expect(parseMaxSize("-1M")).toBeNull();
  });

  it("rejects sizes small enough to rotate constantly", () => {
    expect(isValidMaxSize("1K")).toBe(true);
    expect(isValidMaxSize("100")).toBe(false);
    expect(isValidMaxSize("lots")).toBe(false);
  });

  it("defaults to 50M / keep 7 / gzip / every 30s, enabled", () => {
    expect(resolveLogRotation()).toEqual({
      enabled: true,
      maxSize: "50M",
      retain: 7,
      compress: true,
      interval: 30,
    });
    expect(resolveLogRotation({ retain: 3 }).retain).toBe(3);
  });
});

describe("parseProbe", () => {
  it("reads install state, version, settings, and every process's log paths", () => {
    const state = parseProbe(probeOutput({ ...UP_TO_DATE, apps: ["api", "payroll"] }));
    expect(state.pm2Home).toBe(HOME);
    expect(state.installed).toBe(true);
    expect(state.version).toBe(LOGROTATE_VERSION);
    expect(state.moduleStatus).toBe("online");
    expect(state.settings.max_size).toBe("50M");
    expect(state.processes.find((p) => p.name === "payroll")?.logPaths).toEqual([
      `${HOME}/logs/payroll-out.log`,
      `${HOME}/logs/payroll-error.log`,
    ]);
    expect(state.processes.find((p) => p.name === "pm2-logrotate")?.isModule).toBe(true);
  });

  it("copes with a fresh PM2 home (no module_conf.json) and a daemon spawn banner", () => {
    const state = parseProbe(probeOutput({ banner: true }));
    expect(state.installed).toBe(false);
    expect(state.version).toBeNull();
    expect(state.moduleStatus).toBeNull();
    expect(state.settings).toEqual({});
  });

  it("ignores /dev/null log paths", () => {
    const out = probeOutput().replace(`${HOME}/logs/api-error.log`, "/dev/null");
    expect(parseProbe(out).processes[0].logPaths).toEqual([`${HOME}/logs/api-out.log`]);
  });

  it("throws a clear error when PM2 can't be reached", () => {
    const out = probeOutput().replace(/\[\{.*\}\]$/s, "pm2: command not found");
    expect(() => parseProbe(out)).toThrow(/pm2 jlist/);
  });

  it("lists PM2 daemons of every user, e.g. a root-owned one", () => {
    const state = parseProbe(
      probeOutput({
        daemons: [
          `deploy   PM2 v6.0.8: God Daemon (${HOME})`,
          "root     PM2 v5.3.0: God Daemon (/root/.pm2)",
        ],
      }),
    );
    expect(state.daemons).toEqual([
      { user: "deploy", pm2Home: HOME },
      { user: "root", pm2Home: "/root/.pm2" },
    ]);
  });
});

describe("readServerSettings", () => {
  it("reads values the way pm2-logrotate does (strings or booleans)", () => {
    expect(
      readServerSettings({ max_size: "10M", retain: "30", compress: "false", workerInterval: "30" }),
    ).toEqual({ maxSize: "10M", retain: 30, compress: false, interval: 30 });
    expect(readServerSettings({ retain: "all" }).retain).toBeNull();
  });
});

describe("planLogRotation", () => {
  it("installs on a server without the module", () => {
    const plan = planLogRotation(parseProbe(probeOutput()));
    expect(plan.action).toBe("install");
    expect(plan.conf).toEqual(DESIRED_CONF);
  });

  it("is a no-op on a server already set up (idempotent)", () => {
    const plan = planLogRotation(parseProbe(probeOutput(UP_TO_DATE)));
    expect(plan.action).toBe("none");
    expect(plan.changed).toEqual([]);
  });

  it("restarts only the module when settings change", () => {
    const plan = planLogRotation(parseProbe(probeOutput(UP_TO_DATE)), { maxSize: "100M" });
    expect(plan.action).toBe("restart");
    expect(plan.changed).toEqual(["max_size"]);
  });

  it("upgrades a pre-3.0.1 install, whose compress setting is ignored", () => {
    const plan = planLogRotation(
      parseProbe(probeOutput({ ...UP_TO_DATE, version: "2.7.0" })),
    );
    expect(plan.action).toBe("upgrade");
  });

  it("reinstalls a registered module whose PM2 process is gone", () => {
    const plan = planLogRotation(
      parseProbe(probeOutput({ ...UP_TO_DATE, moduleStatus: null })),
    );
    expect(plan.action).toBe("install");
  });

  it("restarts a stopped or errored module", () => {
    const plan = planLogRotation(
      parseProbe(probeOutput({ ...UP_TO_DATE, moduleStatus: "errored" })),
    );
    expect(plan.action).toBe("restart");
  });

  it("never installs a second worker next to a hand-started one", () => {
    const plan = planLogRotation(
      parseProbe(probeOutput({ ...UP_TO_DATE, installed: false })),
    );
    expect(plan.action).toBe("none");
    expect(plan.notes.join()).toMatch(/isn't registered/);
  });

  it("keeps an existing higher retain so migration deletes no archives", () => {
    const state = parseProbe(
      probeOutput({ ...UP_TO_DATE, settings: { ...DESIRED_CONF, retain: "30" } }),
    );
    const plan = planLogRotation(state);
    expect(plan.settings.retain).toBe(30);
    expect(plan.changed).not.toContain("retain");
    expect(plan.notes.join()).toMatch(/kept the server's existing retain of 30/);
  });

  it("lowers retain when nodeploy.yml asks for it explicitly", () => {
    const state = parseProbe(
      probeOutput({ ...UP_TO_DATE, settings: { ...DESIRED_CONF, retain: "30" } }),
    );
    expect(planLogRotation(state, { retain: 7 }).changed).toEqual(["retain"]);
  });

  it("applies the default retain where the server kept every archive", () => {
    const state = parseProbe(
      probeOutput({ ...UP_TO_DATE, settings: { ...DESIRED_CONF, retain: "all" } }),
    );
    const plan = planLogRotation(state);
    expect(plan.settings.retain).toBe(7);
    expect(plan.changed).toEqual(["retain"]);
  });
});

describe("ensureLogRotation", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  it("on a fresh server writes the settings first, then installs the pinned module, all through nvm", async () => {
    execa.mockResolvedValueOnce({ stdout: probeOutput() });
    execa.mockResolvedValueOnce({ stdout: "" }); // write module_conf.json
    execa.mockResolvedValueOnce({ stdout: "" }); // pm2 install

    const result = await ensureLogRotation(target);
    expect(result.status).toBe("installed");
    expect(execa).toHaveBeenCalledTimes(3);

    // Probe runs via nvm so pm2 resolves in a non-login shell.
    expect(remoteCommand(0)).toBe(withNvm("sh -s"));

    // Settings land before install, so the module's first pass never runs
    // with its own 10M/uncompressed defaults.
    expect(remoteCommand(1)).toContain(withNvm("mkdir -p"));
    expect(remoteCommand(1)).toContain("node -e");
    expect(remoteCommand(1)).toContain("module_conf.json");
    expect(JSON.parse(execa.mock.calls[1][2].input)).toEqual(DESIRED_CONF);

    expect(remoteCommand(2)).toBe(withNvm(`pm2 install pm2-logrotate@${LOGROTATE_VERSION}`));
  });

  it("does nothing beyond the probe when run again (no duplicate install or restart)", async () => {
    execa.mockResolvedValueOnce({ stdout: probeOutput(UP_TO_DATE) });
    const result = await ensureLogRotation(target);
    expect(result.status).toBe("unchanged");
    expect(execa).toHaveBeenCalledTimes(1);
  });

  it("applies changed settings with a single module restart, never an app restart", async () => {
    execa.mockResolvedValueOnce({ stdout: probeOutput(UP_TO_DATE) });
    execa.mockResolvedValueOnce({ stdout: "" });
    execa.mockResolvedValueOnce({ stdout: "" });

    const result = await ensureLogRotation(target, { retain: 3, compress: false });
    expect(result.status).toBe("updated");
    expect(remoteCommand(2)).toBe(withNvm("pm2 restart pm2-logrotate --update-env"));
    for (let i = 0; i < execa.mock.calls.length; i++) {
      expect(remoteCommand(i)).not.toMatch(/pm2 (restart|reload|delete) (?!pm2-logrotate)/);
    }
  });

  it("never touches existing log files during setup", async () => {
    execa.mockResolvedValueOnce({ stdout: probeOutput({ apps: ["payroll", "office-flow-crm"] }) });
    execa.mockResolvedValue({ stdout: "" });
    await ensureLogRotation(target);
    for (let i = 0; i < execa.mock.calls.length; i++) {
      const command = remoteCommand(i);
      expect(command).not.toMatch(/\brm\b|truncate|: >|\/logs\//);
    }
  });

  it("changes nothing when log_rotation.enabled is false", async () => {
    execa.mockResolvedValueOnce({ stdout: probeOutput() });
    const result = await ensureLogRotation(target, { enabled: false });
    expect(result.status).toBe("disabled");
    expect(execa).toHaveBeenCalledTimes(1);
  });

  it("tells the caller before changing anything, so an npm install isn't a silent pause", async () => {
    execa.mockResolvedValue({ stdout: probeOutput() });
    const onChange = vi.fn();
    await ensureLogRotation(target, {}, onChange);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ action: "install" }));

    execa.mockReset();
    execa.mockResolvedValue({ stdout: probeOutput(UP_TO_DATE) });
    const quiet = vi.fn();
    await ensureLogRotation(target, {}, quiet);
    expect(quiet).not.toHaveBeenCalled();
  });

  it("surfaces a failed install instead of reporting success", async () => {
    execa.mockResolvedValueOnce({ stdout: probeOutput() });
    execa.mockResolvedValueOnce({ stdout: "" });
    execa.mockRejectedValueOnce(new Error("npm ERR! network"));
    await expect(ensureLogRotation(target)).rejects.toThrow(/npm ERR/);
  });
});

describe("describeEnsureResult", () => {
  it("warns about PM2 daemons owned by other users", async () => {
    execa.mockReset();
    execa.mockResolvedValueOnce({
      stdout: probeOutput({
        ...UP_TO_DATE,
        daemons: [
          `deploy   PM2 v6.0.8: God Daemon (${HOME})`,
          "root     PM2 v5.3.0: God Daemon (/root/.pm2)",
        ],
      }),
    });
    const messages = describeEnsureResult(await ensureLogRotation(target), "deploy");
    expect(messages[0]).toMatchObject({ level: "success" });
    expect(messages.some((m) => m.level === "warn" && m.text.includes("/root/.pm2"))).toBe(true);
  });

  it("warns when disabled but the module is still installed", async () => {
    execa.mockReset();
    execa.mockResolvedValueOnce({ stdout: probeOutput(UP_TO_DATE) });
    const messages = describeEnsureResult(
      await ensureLogRotation(target, { enabled: false }),
      "deploy",
    );
    expect(messages[0].level).toBe("warn");
    expect(messages[0].text).toContain("pm2 uninstall pm2-logrotate");
  });
});

describe("disk usage", () => {
  const state = parseProbe(probeOutput({ ...UP_TO_DATE, apps: ["payroll", "api"] }));
  const lsLogs = [
    "total 9000000",
    "-rw-r--r-- 1 1000 1000 4402341478 Nov 17 10:00 payroll-error.log",
    "-rw-r--r-- 1 1000 1000 1048576 Nov 17 10:00 payroll-out.log",
    "-rw-r--r-- 1 1000 1000 5242880 Nov 16 00:00 payroll-error__2026-11-16_00-00-00.log.gz",
    "-rw-r--r-- 1 1000 1000 2048 Nov 17 10:00 api-out.log",
    "-rw-r--r-- 1 1000 1000 0 Nov 17 10:00 api-error.log",
    "-rw-r--r-- 1 1000 1000 734003200 Mar  1  2026 office-flow-crm-error.log",
    "drwxr-xr-x 2 1000 1000 4096 Nov 17 10:00 some dir",
  ];
  const lsHome = [
    "total 4000000",
    "-rw-r--r-- 1 1000 1000 4194304000 Nov 17 10:00 pm2.log",
    "-rw-r--r-- 1 1000 1000 1234 Nov 17 10:00 dump.pm2",
    "drwxr-xr-x 2 1000 1000 4096 Nov 17 10:00 logs",
  ];
  const stdout = [
    `${S} dir ${HOME}/logs`,
    ...lsLogs,
    `${S} dir ${HOME}`,
    ...lsHome,
    `${S} df`,
    "/dev/sda2  51200000  48640000  2560000  95% /",
  ].join("\n");
  const listing = parseListing(stdout, `${HOME}/logs`, liveLogPaths(state));

  it("lists every log file plus pm2.log, but not PM2's other files", () => {
    const names = listing.files.map((f) => f.path.split("/").pop());
    expect(names).toContain("pm2.log");
    expect(names).toContain("office-flow-crm-error.log");
    expect(names).not.toContain("dump.pm2");
    expect(names).not.toContain("some dir");
    expect(listing.disk).toEqual({
      sizeBytes: 51200000 * 1024,
      usedBytes: 48640000 * 1024,
      availableBytes: 2560000 * 1024,
      mount: "/",
    });
  });

  it("reports directories it can't list", () => {
    const denied = parseListing(
      `${S} dir /var/log/app\nls: cannot open directory '/var/log/app': Permission denied\n${S} df\n`,
      `${HOME}/logs`,
      [],
    );
    expect(denied.errors).toEqual(["cannot open directory '/var/log/app': Permission denied"]);
    expect(denied.files).toEqual([]);
  });

  it("maps archives back to the log they came from", () => {
    expect(archiveSource(`${HOME}/logs/api-out__2026-11-17_10-00-00.log.gz`)).toBe(
      `${HOME}/logs/api-out.log`,
    );
    expect(archiveSource(`${HOME}/logs/api-out__2026-11-17_10-00-00.log`)).toBe(
      `${HOME}/logs/api-out.log`,
    );
    expect(archiveSource(`${HOME}/logs/api-out.log`)).toBeNull();
  });

  it("totals sizes per app, counts archives, and ranks the largest files", () => {
    const usage = summarizeLogUsage(listing.files, state);
    const payroll = usage.apps.find((a) => a.name === "payroll")!;
    expect(payroll).toMatchObject({
      inPM2: true,
      liveBytes: 4402341478 + 1048576,
      archiveBytes: 5242880,
      archives: 1,
    });
    expect(usage.apps.find((a) => a.name === "pm2 daemon")?.liveBytes).toBe(4194304000);
    expect(usage.apps.find((a) => a.name === "office-flow-crm")?.inPM2).toBe(false);
    expect(usage.apps[0].name).toBe("payroll");
    expect(usage.largest[0].path).toBe(`${HOME}/logs/payroll-error.log`);
    expect(usage.largest).toHaveLength(5);
  });

  it("warns about runaway logs, a high log share, and a full disk", () => {
    const usage = summarizeLogUsage(listing.files, state);
    const warnings = logUsageWarnings(usage, listing.disk, "50M", true);
    expect(warnings.some((w) => w.includes("payroll-error.log") && w.includes("isn't keeping up"))).toBe(true);
    expect(warnings.some((w) => w.includes("unusually high"))).toBe(true);
    expect(warnings.some((w) => w.includes("95% full"))).toBe(true);
    expect(warnings.some((w) => w.includes("api-out.log"))).toBe(false);

    const unrotated = logUsageWarnings(usage, listing.disk, "50M", false);
    expect(unrotated.some((w) => w.includes("nothing is rotating it"))).toBe(true);
  });

  it("warns before the first pass when oversized logs may not fit in the free space", () => {
    const usage = summarizeLogUsage(listing.files, state);
    const tight = { ...listing, disk: { ...listing.disk!, availableBytes: 100 * 1024 * 1024 } };
    const warnings = firstPassWarnings(tight, usage, "50M", true);
    expect(warnings[0]).toMatch(/already over 50M .* nothing is deleted/);
    expect(warnings[1]).toMatch(/only 100.0 MB free/);
    expect(firstPassWarnings(listing, usage, "50M", true)).toHaveLength(1);
  });
});

describe("parseRotateOutput", () => {
  it("parses the rotate script's report", () => {
    const result = parseRotateOutput(
      [
        "rotated\t/l/api-out.log\t/l/api-out__2026-11-17_10-00-00.log.gz",
        "skipped\t/l/api-error.log\tempty",
        "deleted\t/l/api-out__2026-11-01_00-00-00.log.gz",
        "error\t/l/x.log\tno permission to truncate it",
      ].join("\n"),
    );
    expect(result.rotated).toEqual([
      { log: "/l/api-out.log", archive: "/l/api-out__2026-11-17_10-00-00.log.gz" },
    ]);
    expect(result.skipped).toEqual([{ log: "/l/api-error.log", reason: "empty" }]);
    expect(result.deleted).toEqual(["/l/api-out__2026-11-01_00-00-00.log.gz"]);
    expect(result.errors).toHaveLength(1);
  });
});

describe("checkLogRotation (doctor)", () => {
  beforeEach(() => execa.mockReset());

  it("is ok when the module is online", async () => {
    const { checkLogRotation } = await import("../src/lib/doctorChecks.js");
    execa.mockResolvedValueOnce({ stdout: probeOutput(UP_TO_DATE) });
    const result = await checkLogRotation(target, true);
    expect(result.ok).toBe(true);
    expect(result.message).toContain(`pm2-logrotate ${LOGROTATE_VERSION} online: rotate at 50M`);
  });

  it("is an optional failure pointing at `nodeploy logs setup` when not set up", async () => {
    const { checkLogRotation } = await import("../src/lib/doctorChecks.js");
    execa.mockResolvedValueOnce({ stdout: probeOutput() });
    const result = await checkLogRotation(target, true);
    expect(result).toMatchObject({ ok: false, optional: true });
    expect(result.message).toContain("nodeploy logs setup");
  });

  it("never throws, even if the server can't be reached", async () => {
    const { checkLogRotation } = await import("../src/lib/doctorChecks.js");
    execa.mockRejectedValueOnce(new Error("ssh: connect timed out"));
    const result = await checkLogRotation(target, true);
    expect(result).toMatchObject({ ok: false, optional: true });
  });
});
