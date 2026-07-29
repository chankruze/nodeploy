import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadDeployConfig,
  toSSHTarget,
  validateDeployConfig,
} from "../src/lib/deployConfig.js";

describe("validateDeployConfig", () => {
  it("accepts a minimal valid config and applies defaults", () => {
    const config = validateDeployConfig({
      service: "api",
      repo: "git@github.com:user/api.git",
      server: "1.2.3.4",
      ssh: { user: "root" },
    });

    expect(config).toEqual({
      service: "api",
      repo: "git@github.com:user/api.git",
      branch: "main",
      server: "1.2.3.4",
      ssh: { user: "root", keys: undefined, port: 22 },
      deployPath: "$HOME/apps/api",
      nodeVersion: "22",
      runtime: "node",
      entry: undefined,
      port: undefined,
      proxy: undefined,
      startArgs: undefined,
      startScript: undefined,
    });
  });

  it("accepts optional branch, deploy_path, ssh.keys, and ssh.port", () => {
    const config = validateDeployConfig({
      service: "api",
      repo: "git@github.com:user/api.git",
      branch: "develop",
      server: "1.2.3.4",
      ssh: { user: "root", keys: ["~/.ssh/id_ed25519"], port: 2222 },
      deploy_path: "/srv/api",
    });

    expect(config.branch).toBe("develop");
    expect(config.deployPath).toBe("/srv/api");
    expect(config.ssh).toEqual({
      user: "root",
      keys: ["~/.ssh/id_ed25519"],
      port: 2222,
    });
  });

  it("normalizes a ~-prefixed deploy_path to $HOME, which expands correctly inside double-quoted remote commands", () => {
    const config = validateDeployConfig({
      service: "api",
      repo: "git@github.com:user/api.git",
      server: "1.2.3.4",
      ssh: { user: "root" },
      deploy_path: "~/custom/api",
    });

    expect(config.deployPath).toBe("$HOME/custom/api");
  });

  it("accepts a proxy block when port is also set", () => {
    const config = validateDeployConfig({
      service: "api",
      repo: "git@github.com:user/api.git",
      server: "1.2.3.4",
      ssh: { user: "root" },
      port: 3000,
      proxy: { host: "api.local" },
    });

    expect(config.proxy).toEqual({ host: "api.local" });
    expect(config.port).toBe(3000);
  });

  it("accepts start_args and passes it through", () => {
    const config = validateDeployConfig({
      service: "api",
      repo: "git@github.com:user/api.git",
      server: "1.2.3.4",
      ssh: { user: "root" },
      start_args: ["--host"],
    });

    expect(config.startArgs).toEqual(["--host"]);
  });

  it("throws when start_args is not an array of strings", () => {
    expect(() =>
      validateDeployConfig({
        service: "api",
        repo: "git@github.com:user/api.git",
        server: "1.2.3.4",
        ssh: { user: "root" },
        start_args: "--host",
      }),
    ).toThrow(/start_args/);
  });

  it("accepts start_script and passes it through", () => {
    const config = validateDeployConfig({
      service: "api",
      repo: "git@github.com:user/api.git",
      server: "1.2.3.4",
      ssh: { user: "root" },
      start_script: "start:lan",
    });

    expect(config.startScript).toBe("start:lan");
  });

  it("throws when start_script is not a non-empty string", () => {
    expect(() =>
      validateDeployConfig({
        service: "api",
        repo: "git@github.com:user/api.git",
        server: "1.2.3.4",
        ssh: { user: "root" },
        start_script: "",
      }),
    ).toThrow(/start_script/);
  });

  it("throws when service is missing", () => {
    expect(() =>
      validateDeployConfig({
        repo: "git@github.com:user/api.git",
        server: "1.2.3.4",
        ssh: { user: "root" },
      }),
    ).toThrow(/service/);
  });

  it("throws when repo is missing", () => {
    expect(() =>
      validateDeployConfig({
        service: "api",
        server: "1.2.3.4",
        ssh: { user: "root" },
      }),
    ).toThrow(/repo/);
  });

  it("throws when ssh.user is missing", () => {
    expect(() =>
      validateDeployConfig({
        service: "api",
        repo: "git@github.com:user/api.git",
        server: "1.2.3.4",
        ssh: {},
      }),
    ).toThrow(/ssh.user/);
  });

  it("accepts proxy without port (required only for non-static apps, checked at deploy time)", () => {
    const config = validateDeployConfig({
      service: "api",
      repo: "git@github.com:user/api.git",
      server: "1.2.3.4",
      ssh: { user: "root" },
      proxy: { host: "api.local" },
    });

    expect(config.proxy).toEqual({ host: "api.local" });
    expect(config.port).toBeUndefined();
  });

  it("throws on non-object input", () => {
    expect(() => validateDeployConfig(null)).toThrow();
    expect(() => validateDeployConfig("nope")).toThrow();
  });

  it("defaults runtime to node when omitted", () => {
    const config = validateDeployConfig({
      service: "api",
      repo: "git@github.com:user/api.git",
      server: "1.2.3.4",
      ssh: { user: "root" },
    });

    expect(config.runtime).toBe("node");
  });

  it("accepts runtime: python with an entry", () => {
    const config = validateDeployConfig({
      service: "api",
      repo: "git@github.com:user/api.git",
      server: "1.2.3.4",
      ssh: { user: "root" },
      runtime: "python",
      entry: "server.py",
    });

    expect(config.runtime).toBe("python");
    expect(config.entry).toBe("server.py");
  });

  it("throws when runtime is python but entry is missing", () => {
    expect(() =>
      validateDeployConfig({
        service: "api",
        repo: "git@github.com:user/api.git",
        server: "1.2.3.4",
        ssh: { user: "root" },
        runtime: "python",
      }),
    ).toThrow(/entry/);
  });

  it("throws when runtime is not node or python", () => {
    expect(() =>
      validateDeployConfig({
        service: "api",
        repo: "git@github.com:user/api.git",
        server: "1.2.3.4",
        ssh: { user: "root" },
        runtime: "ruby",
      }),
    ).toThrow(/runtime/);
  });
});

describe("loadDeployConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodeploy-deployconfig-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws a descriptive error when the file is missing", () => {
    expect(() => loadDeployConfig(tmpDir, "nodeploy.yml")).toThrow(
      /nodeploy\.yml/,
    );
  });

  it("loads and validates an existing nodeploy.yml", () => {
    fs.writeFileSync(
      path.join(tmpDir, "nodeploy.yml"),
      [
        "service: api",
        "repo: git@github.com:user/api.git",
        "server: 1.2.3.4",
        "ssh:",
        "  user: root",
        "",
      ].join("\n"),
    );

    const config = loadDeployConfig(tmpDir, "nodeploy.yml");
    expect(config.service).toBe("api");
    expect(config.server).toBe("1.2.3.4");
  });
});

describe("toSSHTarget", () => {
  it("derives an SSH target from a deploy config", () => {
    const config = validateDeployConfig({
      service: "api",
      repo: "git@github.com:user/api.git",
      server: "1.2.3.4",
      ssh: { user: "root", keys: ["~/.ssh/id_ed25519"], port: 2222 },
    });

    expect(toSSHTarget(config)).toEqual({
      host: "1.2.3.4",
      user: "root",
      port: 2222,
      keys: ["~/.ssh/id_ed25519"],
    });
  });
});
