import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadDeployConfig,
  setLogRotationInYaml,
  updateLogRotationConfig,
  validateDeployConfig,
} from "../src/lib/deployConfig.js";
import { deployFingerprint } from "../src/lib/deployState.js";

const base = {
  service: "payroll",
  repo: "git@github.com:acme/payroll.git",
  server: "192.168.0.12",
  ssh: { user: "deploy" },
};

describe("log_rotation in nodeploy.yml", () => {
  it("is optional: existing configs load unchanged and get the defaults", () => {
    expect(validateDeployConfig(base).logRotation).toBeUndefined();
    expect("logRotation" in validateDeployConfig(base)).toBe(false);
  });

  it("accepts every setting, normalising sizes to pm2-logrotate's upper-case suffix", () => {
    const config = validateDeployConfig({
      ...base,
      log_rotation: { enabled: true, max_size: "100m", retain: 10, compress: false, interval: 60 },
    });
    expect(config.logRotation).toEqual({
      enabled: true,
      maxSize: "100M",
      retain: 10,
      compress: false,
      interval: 60,
    });
  });

  it("keeps only the keys that were set, so defaults stay distinguishable", () => {
    expect(validateDeployConfig({ ...base, log_rotation: { retain: 3 } }).logRotation).toEqual({
      retain: 3,
    });
  });

  it("treats true/false as shorthand for enabled", () => {
    expect(validateDeployConfig({ ...base, log_rotation: false }).logRotation).toEqual({
      enabled: false,
    });
    expect(validateDeployConfig({ ...base, log_rotation: true }).logRotation).toEqual({
      enabled: true,
    });
  });

  it("accepts a plain number of bytes for max_size", () => {
    expect(
      validateDeployConfig({ ...base, log_rotation: { max_size: 1048576 } }).logRotation,
    ).toEqual({ maxSize: "1048576" });
  });

  it.each([
    [{ max_size: "50MB" }, /max_size/],
    [{ max_size: "10" }, /max_size/],
    [{ retain: 0 }, /retain/],
    [{ retain: 2.5 }, /retain/],
    [{ interval: "30" }, /interval/],
    [{ compress: "yes" }, /compress/],
    [{ max_szie: "50M" }, /unknown key "log_rotation.max_szie"/],
    ["often", /must be true, false, or an object/],
  ])("rejects %j", (logRotation, message) => {
    expect(() => validateDeployConfig({ ...base, log_rotation: logRotation })).toThrow(message);
  });

  it("is rejected for runtime: external, which PM2 doesn't run", () => {
    expect(() =>
      validateDeployConfig({
        service: "api",
        server: "192.168.0.12",
        ssh: { user: "deploy" },
        runtime: "external",
        port: 8090,
        proxy: { host: "api.example.com" },
        log_rotation: { retain: 3 },
      }),
    ).toThrow(/"log_rotation" doesn't apply to runtime: external/);
  });

  it("doesn't change the deploy fingerprint, so rotation settings never trigger a redeploy", () => {
    const plain = validateDeployConfig(base);
    const withRotation = validateDeployConfig({ ...base, log_rotation: { retain: 3 } });
    expect(deployFingerprint(withRotation)).toBe(deployFingerprint(plain));
  });
});

describe("setLogRotationInYaml", () => {
  const source = `# payroll on the office app server
service: payroll
repo: git@github.com:acme/payroll.git
server: 192.168.0.12 # .12
ssh:
  user: deploy
`;

  it("adds a log_rotation block, keeping comments", () => {
    const updated = setLogRotationInYaml(source, { maxSize: "100M", retain: 10 });
    expect(updated).toContain("# payroll on the office app server");
    expect(updated).toContain("server: 192.168.0.12 # .12");
    expect(updated).toContain("log_rotation:\n  max_size: 100M\n  retain: 10\n");
  });

  it("updates existing keys in place", () => {
    const once = setLogRotationInYaml(source, { maxSize: "100M", retain: 10 });
    const twice = setLogRotationInYaml(once, { retain: 3, compress: false });
    expect(twice).toContain("log_rotation:\n  max_size: 100M\n  retain: 3\n  compress: false\n");
  });

  it("expands the true/false shorthand", () => {
    const updated = setLogRotationInYaml(`${source}log_rotation: false\n`, { retain: 3 });
    expect(updated).toContain("log_rotation:\n  enabled: false\n  retain: 3\n");
  });
});

describe("updateLogRotationConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nodeploy-yml-"));
    fs.writeFileSync(
      path.join(dir, "nodeploy.yml"),
      "service: payroll\nrepo: git@github.com:acme/payroll.git\nserver: 192.168.0.12\nssh:\n  user: deploy\n",
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes the change and returns the reloaded config", () => {
    const config = updateLogRotationConfig(dir, "nodeploy.yml", { interval: 60 });
    expect(config.logRotation).toEqual({ interval: 60 });
    expect(loadDeployConfig(dir, "nodeploy.yml").logRotation).toEqual({ interval: 60 });
  });
});

describe("backup in nodeploy.yml", () => {
  it("applies defaults: daily, keep 14", () => {
    expect(validateDeployConfig({ ...base, backup: { paths: ["data/app.db", "uploads/"] } }).backup).toEqual({
      paths: ["data/app.db", "uploads"],
      schedule: "daily",
      keep: 14,
    });
  });

  it("accepts hourly, off, and cron expressions", () => {
    for (const schedule of ["hourly", "off", "30 1 * * *", "*/15 * * * 1-5"]) {
      expect(validateDeployConfig({ ...base, backup: { paths: ["d"], schedule } }).backup?.schedule).toBe(schedule);
    }
  });

  it.each([
    [{}, /backup.paths/],
    [{ paths: [] }, /backup.paths/],
    [{ paths: ["/etc/passwd"] }, /inside deploy_path/],
    [{ paths: ["../other-app/data"] }, /inside deploy_path/],
    [{ paths: ["~/x"] }, /inside deploy_path/],
    [{ paths: ["d"], schedule: "weekly" }, /backup.schedule/],
    [{ paths: ["d"], schedule: "1 2 3" }, /backup.schedule/],
    [{ paths: ["d"], keep: 0 }, /backup.keep/],
    [{ paths: ["d"], retain: 3 }, /unknown key "backup.retain"/],
    [["data"], /must be an object/],
  ])("rejects %j", (backup, message) => {
    expect(() => validateDeployConfig({ ...base, backup })).toThrow(message);
  });

  it("is rejected for runtime: external", () => {
    expect(() =>
      validateDeployConfig({
        service: "api",
        server: "192.168.0.12",
        ssh: { user: "deploy" },
        runtime: "external",
        port: 8090,
        proxy: { host: "api.example.com" },
        backup: { paths: ["d"] },
      }),
    ).toThrow(/"backup" doesn't apply to runtime: external/);
  });

  it("doesn't change the deploy fingerprint", () => {
    expect(deployFingerprint(validateDeployConfig({ ...base, backup: { paths: ["d"] } }))).toBe(
      deployFingerprint(validateDeployConfig(base)),
    );
  });
});
