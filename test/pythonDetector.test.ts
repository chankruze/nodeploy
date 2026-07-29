import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const {
  detectPythonAppType,
  resolvePythonInstallCmd,
  fetchPythonManifest,
} = await import("../src/lib/pythonDetector.js");

const target: SSHTarget = {
  host: "203.0.113.10",
  user: "root",
  port: 22,
};

function manifest(overrides: Partial<Parameters<typeof detectPythonAppType>[0]> = {}) {
  return {
    hasRequirementsTxt: false,
    hasPyprojectToml: false,
    manifestContent: "",
    ...overrides,
  };
}

describe("detectPythonAppType", () => {
  it("detects flask from a requirements.txt-style manifest", () => {
    expect(
      detectPythonAppType(manifest({ manifestContent: "Flask==3.0.0\n" })),
    ).toBe("flask");
  });

  it("detects flask case-insensitively and anywhere in the manifest", () => {
    expect(
      detectPythonAppType(
        manifest({ manifestContent: "gunicorn\nflask>=2.0\n" }),
      ),
    ).toBe("flask");
  });

  it("falls back to python for a pure-stdlib app with no manifest", () => {
    expect(detectPythonAppType(manifest())).toBe("python");
  });

  it("falls back to python when the manifest has unrelated dependencies", () => {
    expect(
      detectPythonAppType(manifest({ manifestContent: "requests==2.31.0\n" })),
    ).toBe("python");
  });
});

describe("resolvePythonInstallCmd", () => {
  it("creates a venv with no pip install when there is no manifest", () => {
    const cmd = resolvePythonInstallCmd(manifest(), "~/apps/api/.venv");
    expect(cmd).toEqual(['python3 -m venv "~/apps/api/.venv"']);
  });

  it("creates a venv and installs from requirements.txt when present", () => {
    const cmd = resolvePythonInstallCmd(
      manifest({ hasRequirementsTxt: true }),
      "~/apps/api/.venv",
    );
    expect(cmd[0]).toContain('python3 -m venv "~/apps/api/.venv"');
    expect(cmd[0]).toContain('install -r requirements.txt');
  });

  it("creates a venv and installs from pyproject.toml when present", () => {
    const cmd = resolvePythonInstallCmd(
      manifest({ hasPyprojectToml: true }),
      "~/apps/api/.venv",
    );
    expect(cmd[0]).toContain('python3 -m venv "~/apps/api/.venv"');
    expect(cmd[0]).toContain('install .');
  });

  it("prefers requirements.txt over pyproject.toml when both are present", () => {
    const cmd = resolvePythonInstallCmd(
      manifest({ hasRequirementsTxt: true, hasPyprojectToml: true }),
      "~/apps/api/.venv",
    );
    expect(cmd[0]).toContain("requirements.txt");
  });
});

describe("fetchPythonManifest", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  it("reads requirements.txt when present", async () => {
    execa.mockResolvedValueOnce({
      stdout: "REQUIREMENTS_TXT\nflask==3.0.0\n",
    });

    const result = await fetchPythonManifest(target, "~/apps/api");
    expect(result.hasRequirementsTxt).toBe(true);
    expect(result.hasPyprojectToml).toBe(false);
    expect(result.manifestContent).toContain("flask==3.0.0");
  });

  it("reads pyproject.toml when requirements.txt is absent", async () => {
    execa.mockResolvedValueOnce({
      stdout: "PYPROJECT_TOML\n[project]\ndependencies = [\"flask\"]\n",
    });

    const result = await fetchPythonManifest(target, "~/apps/api");
    expect(result.hasPyprojectToml).toBe(true);
    expect(result.hasRequirementsTxt).toBe(false);
  });

  it("returns an empty manifest when neither file exists", async () => {
    execa.mockResolvedValueOnce({ stdout: "NONE\n" });

    const result = await fetchPythonManifest(target, "~/apps/api");
    expect(result.hasRequirementsTxt).toBe(false);
    expect(result.hasPyprojectToml).toBe(false);
  });
});
