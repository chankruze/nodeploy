import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { TEMPLATE } from "../src/commands/init.js";
import { validateDeployConfig } from "../src/lib/deployConfig.js";

/** Uncomments a commented-out top-level block of the template, as a user would. */
function uncomment(template: string, key: string): string {
  const lines = template.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`# ${key}:`));
  if (start < 0) throw new Error(`no ${key} block`);
  for (let i = start; i < lines.length && lines[i].startsWith("#"); i++) {
    if (i > start && !lines[i].startsWith("#  ")) break;
    lines[i] = lines[i].replace(/^# ?/, "");
  }
  return lines.join("\n");
}

describe("init template", () => {
  it("is a valid nodeploy.yml as generated", () => {
    expect(() => validateDeployConfig(parse(TEMPLATE))).not.toThrow();
  });

  it("stays valid with the log_rotation block uncommented, and has the defaults", () => {
    const config = validateDeployConfig(parse(uncomment(TEMPLATE, "log_rotation")));
    expect(config.logRotation).toEqual({ maxSize: "50M", retain: 7, compress: true, interval: 30 });
  });

  it("stays valid with the backup block uncommented", () => {
    const config = validateDeployConfig(parse(uncomment(TEMPLATE, "backup")));
    expect(config.backup).toEqual({ paths: ["data"], schedule: "daily", keep: 14 });
  });

  it("stays valid with backup.email and backup.download uncommented too", () => {
    const text = uncomment(TEMPLATE, "backup")
      .replace("  # email:", "  email:")
      .replace("  #   to:", "    to:")
      .replace("  #   smtp:", "    smtp:")
      .replace("  # download:", "  download:")
      .replace("  #   lan_port:", "    lan_port:")
      .replace("  #   expires:", "    expires:");
    const backup = validateDeployConfig(parse(text)).backup!;
    expect(backup.email?.smtp).toEqual({ host: "smtp.example.com", port: 587, user: "backups@example.com" });
    expect(backup.download).toEqual({ lanPort: 8799, public: false, expiresDays: 7 });
  });

  it("stays valid with backup.copy_to uncommented too", () => {
    const text = uncomment(TEMPLATE, "backup").replace("  # copy_to:", "  copy_to:").replace("  #   server:", "    server:");
    expect(validateDeployConfig(parse(text)).backup?.copyTo?.server).toBe("192.168.0.12");
  });
});
