import { describe, expect, it } from "vitest";
import { detectAppType, resolveCommands, resolveStaticDir } from "../src/lib/detector.js";
import type { PackageJson } from "../src/types.js";

function pkg(overrides: Partial<PackageJson>): PackageJson {
  return {
    scripts: {},
    dependencies: {},
    devDependencies: {},
    ...overrides,
  };
}

describe("detectAppType", () => {
  it("detects nestjs", () => {
    const p = pkg({
      scripts: { build: "nest build", "start:prod": "node dist/main" },
      dependencies: { "@nestjs/core": "^10.0.0" },
    });
    expect(detectAppType(p)).toBe("nestjs");
  });

  it("detects nextjs", () => {
    const p = pkg({
      scripts: { build: "next build", start: "next start" },
      dependencies: { next: "^14.0.0" },
    });
    expect(detectAppType(p)).toBe("nextjs");
  });

  it("detects vite", () => {
    const p = pkg({
      scripts: { build: "vite build", preview: "vite preview" },
      devDependencies: { vite: "^5.0.0" },
    });
    expect(detectAppType(p)).toBe("vite");
  });

  it("detects cra", () => {
    const p = pkg({
      scripts: { build: "react-scripts build", serve: "serve -s build" },
      dependencies: { "react-scripts": "^5.0.0", react: "^18.0.0" },
    });
    expect(detectAppType(p)).toBe("cra");
  });

  it("detects express", () => {
    const p = pkg({
      scripts: { start: "node server.js" },
      dependencies: { express: "^4.0.0" },
    });
    expect(detectAppType(p)).toBe("express");
  });

  it("detects remix", () => {
    const p = pkg({
      scripts: { build: "remix vite:build", start: "remix-serve ./build/server/index.js" },
      dependencies: { "@remix-run/serve": "^2.0.0", "@remix-run/react": "^2.0.0" },
    });
    expect(detectAppType(p)).toBe("remix");
  });

  it("falls back to generic for a plain node start script with no framework dependency", () => {
    const p = pkg({
      scripts: { start: "node server.js" },
    });
    expect(detectAppType(p)).toBe("generic");
  });

  it("falls back to generic when build+start scripts exist but no framework dependency", () => {
    const p = pkg({
      scripts: { build: "tsc", start: "node dist/index.js" },
    });
    expect(detectAppType(p)).toBe("generic");
  });

  it("falls back to generic when nestjs scripts match but the dependency is missing", () => {
    const p = pkg({
      scripts: { build: "tsc", "start:prod": "node dist/main" },
    });
    expect(detectAppType(p)).toBe("generic");
  });

  it("falls back to generic when no scripts are present", () => {
    expect(detectAppType(pkg({}))).toBe("generic");
  });
});

describe("resolveCommands", () => {
  it("resolves nestjs commands", () => {
    expect(resolveCommands("nestjs", pkg({}))).toEqual({
      buildCmd: ["run", "build"],
      startCmd: ["run", "start:prod"],
    });
  });

  it("resolves nextjs commands", () => {
    expect(resolveCommands("nextjs", pkg({}))).toEqual({
      buildCmd: ["run", "build"],
      startCmd: ["run", "start"],
    });
  });

  it("resolves remix commands", () => {
    expect(resolveCommands("remix", pkg({}))).toEqual({
      buildCmd: ["run", "build"],
      startCmd: ["run", "start"],
    });
  });

  it("resolves vite commands", () => {
    expect(resolveCommands("vite", pkg({}))).toEqual({
      buildCmd: ["run", "build"],
      startCmd: ["run", "preview"],
    });
  });

  it("resolves cra commands", () => {
    expect(resolveCommands("cra", pkg({}))).toEqual({
      buildCmd: ["run", "build"],
      startCmd: ["run", "serve"],
    });
  });

  it("resolves express commands with no build step", () => {
    expect(resolveCommands("express", pkg({}))).toEqual({
      buildCmd: null,
      startCmd: ["run", "start"],
    });
  });

  it("resolves generic commands using build script when present", () => {
    const p = pkg({ scripts: { build: "tsc", start: "node dist/index.js" } });
    expect(resolveCommands("generic", p)).toEqual({
      buildCmd: ["run", "build"],
      startCmd: ["run", "start"],
    });
  });

  it("resolves generic commands picking the first available start-like script", () => {
    const p = pkg({ scripts: { serve: "node server.js" } });
    expect(resolveCommands("generic", p)).toEqual({
      buildCmd: null,
      startCmd: ["run", "serve"],
    });
  });

  it("resolves generic commands defaulting to start when nothing matches", () => {
    expect(resolveCommands("generic", pkg({}))).toEqual({
      buildCmd: null,
      startCmd: ["run", "start"],
    });
  });
});

describe("resolveStaticDir", () => {
  it("returns the build output dir for vite", () => {
    expect(resolveStaticDir("vite")).toBe("dist");
  });

  it("returns the build output dir for cra", () => {
    expect(resolveStaticDir("cra")).toBe("build");
  });

  it("returns null for app types that need a running process", () => {
    expect(resolveStaticDir("nextjs")).toBeNull();
    expect(resolveStaticDir("remix")).toBeNull();
    expect(resolveStaticDir("express")).toBeNull();
    expect(resolveStaticDir("nestjs")).toBeNull();
    expect(resolveStaticDir("generic")).toBeNull();
  });
});
