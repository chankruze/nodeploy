import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteApp, SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const { SSHPM2Adapter } = await import("../src/lib/pm2.js");
const { withNvm } = await import("../src/lib/remoteEnv.js");

const target: SSHTarget = {
  host: "203.0.113.10",
  user: "root",
  port: 22,
};

function makeApp(overrides: Partial<RemoteApp> = {}): RemoteApp {
  return {
    name: "api",
    dir: "~/apps/api",
    type: "express",
    packageManager: "npm",
    installCmd: ["npm", "install"],
    buildCmd: null,
    startCmd: ["run", "start"],
    ...overrides,
  };
}

function jlistProcess(overrides: Record<string, unknown> = {}) {
  return {
    name: "api",
    pid: 1234,
    pm2_env: {
      status: "online",
      pm_uptime: 1000,
      restart_time: 2,
      ...(overrides.pm2_env as object),
    },
    monit: { cpu: 1.5, memory: 50_000_000, ...(overrides.monit as object) },
  };
}

describe("SSHPM2Adapter", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  it("start() calls pm2 start with the app's start script when not already running", async () => {
    execa.mockResolvedValueOnce({ stdout: "[]" }); // list()
    execa.mockResolvedValueOnce({}); // start
    execa.mockResolvedValueOnce({}); // save

    const adapter = new SSHPM2Adapter(target);
    await adapter.start(makeApp({ startCmd: ["run", "start:prod"] }));

    expect(execa).toHaveBeenNthCalledWith(
      1,
      "ssh",
      ["-p", "22", "root@203.0.113.10", withNvm("pm2 jlist")],
      {},
    );
    expect(execa).toHaveBeenNthCalledWith(
      2,
      "ssh",
      [
        "-p",
        "22",
        "root@203.0.113.10",
        withNvm('cd "~/apps/api" && pm2 start npm --name "api" -- run start:prod'),
      ],
      {},
    );
    expect(execa).toHaveBeenNthCalledWith(
      3,
      "ssh",
      ["-p", "22", "root@203.0.113.10", withNvm("pm2 save")],
      {},
    );
  });

  it("start() calls restart instead when the app is already running", async () => {
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify([jlistProcess()]),
    }); // list()
    execa.mockResolvedValueOnce({}); // restart
    execa.mockResolvedValueOnce({}); // save

    const adapter = new SSHPM2Adapter(target);
    await adapter.start(makeApp());

    expect(execa).toHaveBeenNthCalledWith(
      2,
      "ssh",
      ["-p", "22", "root@203.0.113.10", withNvm('pm2 restart "api"')],
      {},
    );
    expect(execa).toHaveBeenNthCalledWith(
      3,
      "ssh",
      ["-p", "22", "root@203.0.113.10", withNvm("pm2 save")],
      {},
    );
  });

  it("restart() calls pm2 restart", async () => {
    execa.mockResolvedValueOnce({});
    await new SSHPM2Adapter(target).restart("api");
    expect(execa).toHaveBeenCalledWith(
      "ssh",
      ["-p", "22", "root@203.0.113.10", withNvm('pm2 restart "api"')],
      {},
    );
  });

  it("stop() calls pm2 stop", async () => {
    execa.mockResolvedValueOnce({});
    await new SSHPM2Adapter(target).stop("api");
    expect(execa).toHaveBeenCalledWith(
      "ssh",
      ["-p", "22", "root@203.0.113.10", withNvm('pm2 stop "api"')],
      {},
    );
  });

  it("delete() calls pm2 delete", async () => {
    execa.mockResolvedValueOnce({});
    await new SSHPM2Adapter(target).delete("api");
    expect(execa).toHaveBeenCalledWith(
      "ssh",
      ["-p", "22", "root@203.0.113.10", withNvm('pm2 delete "api"')],
      {},
    );
  });

  it("list() maps pm2 jlist output into PM2ProcessInfo", async () => {
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify([jlistProcess()]),
    });

    const result = await new SSHPM2Adapter(target).list();

    expect(result).toEqual([
      {
        name: "api",
        pid: 1234,
        status: "online",
        cpu: 1.5,
        memoryBytes: 50_000_000,
        uptimeMs: expect.any(Number),
        restarts: 2,
      },
    ]);
  });

  it("list() maps unrecognized statuses to unknown", async () => {
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify([
        jlistProcess({ pm2_env: { status: "something-new" } }),
      ]),
    });

    const result = await new SSHPM2Adapter(target).list();
    expect(result[0].status).toBe("unknown");
  });

  it("logs() streams via inherited stdio and passes --lines when provided", async () => {
    execa.mockResolvedValueOnce({});
    await new SSHPM2Adapter(target).logs("api", { lines: 50 });

    expect(execa).toHaveBeenCalledWith(
      "ssh",
      [
        "-p",
        "22",
        "root@203.0.113.10",
        withNvm('pm2 logs "api" --lines 50'),
      ],
      { stdio: "inherit" },
    );
  });

  it("isInstalled() returns true when pm2 --version resolves", async () => {
    execa.mockResolvedValueOnce({});
    await expect(new SSHPM2Adapter(target).isInstalled()).resolves.toBe(true);
  });

  it("isInstalled() returns false when pm2 --version rejects", async () => {
    execa.mockRejectedValueOnce(new Error("command not found"));
    await expect(new SSHPM2Adapter(target).isInstalled()).resolves.toBe(false);
  });

  it("save() calls pm2 save", async () => {
    execa.mockResolvedValueOnce({});
    await new SSHPM2Adapter(target).save();
    expect(execa).toHaveBeenCalledWith(
      "ssh",
      ["-p", "22", "root@203.0.113.10", withNvm("pm2 save")],
      {},
    );
  });
});
