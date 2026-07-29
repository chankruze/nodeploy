import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeployConfig, SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const { resolveRemoteApp } = await import("../src/lib/remoteApp.js");

const target: SSHTarget = {
  host: "203.0.113.10",
  user: "root",
  port: 22,
};

function makeConfig(overrides: Partial<DeployConfig> = {}): DeployConfig {
  return {
    service: "api",
    repo: "git@github.com:user/api.git",
    branch: "main",
    server: "203.0.113.10",
    ssh: { user: "root", port: 22 },
    deployPath: "~/apps/api",
    nodeVersion: "22",
    runtime: "node",
    ...overrides,
  };
}

describe("resolveRemoteApp (python)", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  it("resolves a pure-stdlib python app with no manifest", async () => {
    execa.mockResolvedValueOnce({ stdout: "NONE\n" }); // fetchPythonManifest

    const app = await resolveRemoteApp(
      target,
      makeConfig({ runtime: "python", entry: "server.py" }),
    );

    expect(app.runtime).toBe("python");
    expect(app.type).toBe("python");
    expect(app.startCmd).toEqual(["server.py"]);
    expect(app.interpreter).toBe("~/apps/api/.venv/bin/python3");
    expect(app.installCmd).toEqual(['python3 -m venv "~/apps/api/.venv"']);
  });

  it("resolves a flask app from requirements.txt", async () => {
    execa.mockResolvedValueOnce({
      stdout: "REQUIREMENTS_TXT\nFlask==3.0.0\n",
    });

    const app = await resolveRemoteApp(
      target,
      makeConfig({ runtime: "python", entry: "app.py" }),
    );

    expect(app.type).toBe("flask");
    expect(app.installCmd[0]).toContain("install -r requirements.txt");
  });

  it("passes port through as a PORT env var", async () => {
    execa.mockResolvedValueOnce({ stdout: "NONE\n" });

    const app = await resolveRemoteApp(
      target,
      makeConfig({ runtime: "python", entry: "server.py", port: 8789 }),
    );

    expect(app.env).toEqual({ PORT: "8789" });
  });

  it("omits env when no port is configured", async () => {
    execa.mockResolvedValueOnce({ stdout: "NONE\n" });

    const app = await resolveRemoteApp(
      target,
      makeConfig({ runtime: "python", entry: "server.py" }),
    );

    expect(app.env).toBeUndefined();
  });
});
