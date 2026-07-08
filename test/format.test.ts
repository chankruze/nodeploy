import { describe, expect, it } from "vitest";
import { formatBytes, formatUptime } from "../src/lib/format.js";

describe("formatBytes", () => {
  it("formats sub-1KB values in bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats KB", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("formats MB", () => {
    expect(formatBytes(50_000_000)).toBe("47.7 MB");
  });

  it("formats GB", () => {
    expect(formatBytes(2_147_483_648)).toBe("2.0 GB");
  });
});

describe("formatUptime", () => {
  it("returns a dash for null uptime", () => {
    expect(formatUptime(null)).toBe("-");
  });

  it("returns a dash for negative uptime", () => {
    expect(formatUptime(-100)).toBe("-");
  });

  it("formats seconds", () => {
    expect(formatUptime(45_000)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatUptime(125_000)).toBe("2m 5s");
  });

  it("formats hours and minutes", () => {
    expect(formatUptime(3_725_000)).toBe("1h 2m");
  });

  it("formats days and hours", () => {
    expect(formatUptime(90_000_000)).toBe("1d 1h");
  });
});
