import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectedApp } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const { ExecaPM2Adapter } = await import("../src/lib/pm2.js");

function makeApp(overrides: Partial<DetectedApp> = {}): DetectedApp {
  return {
    name: "api",
    dir: "/apps/api",
    port: 3000,
    type: "express",
    packageManager: "npm",
    installCmd: ["npm", "install"],
    buildCmd: null,
    startCmd: ["run", "start"],
    pkg: {},
    hasNodeployConfig: true,
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

describe("ExecaPM2Adapter", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  it("start() calls pm2 start with the app's start script when not already running", async () => {
    execa.mockResolvedValueOnce({ stdout: "[]" }); // list()
    execa.mockResolvedValueOnce({}); // start

    const adapter = new ExecaPM2Adapter();
    await adapter.start(makeApp({ startCmd: ["run", "start:prod"] }));

    expect(execa).toHaveBeenNthCalledWith(1, "pm2", ["jlist"]);
    expect(execa).toHaveBeenNthCalledWith(
      2,
      "pm2",
      ["start", "npm", "--name", "api", "--", "run", "start:prod"],
      { cwd: "/apps/api" },
    );
  });

  it("start() calls restart instead when the app is already running", async () => {
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify([jlistProcess()]),
    }); // list()
    execa.mockResolvedValueOnce({}); // restart

    const adapter = new ExecaPM2Adapter();
    await adapter.start(makeApp());

    expect(execa).toHaveBeenNthCalledWith(2, "pm2", ["restart", "api"]);
  });

  it("restart() calls pm2 restart", async () => {
    execa.mockResolvedValueOnce({});
    await new ExecaPM2Adapter().restart("api");
    expect(execa).toHaveBeenCalledWith("pm2", ["restart", "api"]);
  });

  it("stop() calls pm2 stop", async () => {
    execa.mockResolvedValueOnce({});
    await new ExecaPM2Adapter().stop("api");
    expect(execa).toHaveBeenCalledWith("pm2", ["stop", "api"]);
  });

  it("delete() calls pm2 delete", async () => {
    execa.mockResolvedValueOnce({});
    await new ExecaPM2Adapter().delete("api");
    expect(execa).toHaveBeenCalledWith("pm2", ["delete", "api"]);
  });

  it("list() maps pm2 jlist output into PM2ProcessInfo", async () => {
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify([jlistProcess()]),
    });

    const result = await new ExecaPM2Adapter().list();

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

    const result = await new ExecaPM2Adapter().list();
    expect(result[0].status).toBe("unknown");
  });

  it("logs() streams via inherited stdio and passes --lines when provided", async () => {
    execa.mockResolvedValueOnce({});
    await new ExecaPM2Adapter().logs("api", { lines: 50 });

    expect(execa).toHaveBeenCalledWith(
      "pm2",
      ["logs", "api", "--lines", "50"],
      { stdio: "inherit" },
    );
  });

  it("isInstalled() returns true when pm2 --version resolves", async () => {
    execa.mockResolvedValueOnce({});
    await expect(new ExecaPM2Adapter().isInstalled()).resolves.toBe(true);
  });

  it("isInstalled() returns false when pm2 --version rejects", async () => {
    execa.mockRejectedValueOnce(new Error("command not found"));
    await expect(new ExecaPM2Adapter().isInstalled()).resolves.toBe(false);
  });
});
