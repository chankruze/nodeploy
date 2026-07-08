import type { AppType, PackageJson } from "../types.js";

export interface DetectionContext {
  pkg: PackageJson;
}

export interface DetectionRule {
  type: AppType;
  matches(ctx: DetectionContext): boolean;
}

function hasScript(pkg: PackageJson, name: string): boolean {
  return Boolean(pkg.scripts?.[name]);
}

function hasDependency(pkg: PackageJson, name: string): boolean {
  return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
}

/**
 * Ordered most-specific-first. Each framework rule requires both the
 * expected script shape and a dependency marker, so a generic project
 * that merely has matching scripts (e.g. build+start) without the
 * framework dependency correctly falls through to "generic" instead of
 * being misdetected.
 */
export const detectionRules: DetectionRule[] = [
  {
    type: "nestjs",
    matches: ({ pkg }) =>
      hasScript(pkg, "build") &&
      hasScript(pkg, "start:prod") &&
      hasDependency(pkg, "@nestjs/core"),
  },
  {
    type: "nextjs",
    matches: ({ pkg }) =>
      hasScript(pkg, "build") &&
      hasScript(pkg, "start") &&
      hasDependency(pkg, "next"),
  },
  {
    type: "remix",
    matches: ({ pkg }) =>
      hasScript(pkg, "build") &&
      hasScript(pkg, "start") &&
      (hasDependency(pkg, "@remix-run/serve") ||
        hasDependency(pkg, "@remix-run/node") ||
        hasDependency(pkg, "@remix-run/react")),
  },
  {
    type: "vite",
    matches: ({ pkg }) =>
      hasScript(pkg, "build") &&
      hasScript(pkg, "preview") &&
      hasDependency(pkg, "vite"),
  },
  {
    type: "cra",
    matches: ({ pkg }) =>
      hasScript(pkg, "build") &&
      hasScript(pkg, "serve") &&
      (hasDependency(pkg, "react-scripts") || hasDependency(pkg, "react")),
  },
  {
    type: "express",
    matches: ({ pkg }) =>
      hasScript(pkg, "start") &&
      !hasScript(pkg, "build") &&
      hasDependency(pkg, "express"),
  },
];

export function detectAppType(pkg: PackageJson): AppType {
  const ctx: DetectionContext = { pkg };
  const rule = detectionRules.find((r) => r.matches(ctx));
  return rule?.type ?? "generic";
}

/**
 * Output directory of the production build for app types that produce a
 * static bundle with no server process of their own. Types not listed here
 * (nextjs, remix, express, generic) need a running Node process, so they're
 * always deployed under PM2 instead.
 */
const STATIC_OUTPUT_DIRS: Partial<Record<AppType, string>> = {
  vite: "dist",
  cra: "build",
};

export function resolveStaticDir(type: AppType): string | null {
  return STATIC_OUTPUT_DIRS[type] ?? null;
}

const GENERIC_START_SCRIPT_CANDIDATES = [
  "start",
  "start:prod",
  "serve",
  "preview",
];

export function resolveCommands(
  type: AppType,
  pkg: PackageJson,
  startScriptOverride?: string,
): { buildCmd: string[] | null; startCmd: string[] } {
  if (startScriptOverride) {
    const buildCmd = hasScript(pkg, "build") ? ["run", "build"] : null;
    return { buildCmd, startCmd: ["run", startScriptOverride] };
  }

  switch (type) {
    case "nestjs":
      return { buildCmd: ["run", "build"], startCmd: ["run", "start:prod"] };
    case "nextjs":
      return { buildCmd: ["run", "build"], startCmd: ["run", "start"] };
    case "remix":
      return { buildCmd: ["run", "build"], startCmd: ["run", "start"] };
    case "vite":
      return { buildCmd: ["run", "build"], startCmd: ["run", "preview"] };
    case "cra":
      return { buildCmd: ["run", "build"], startCmd: ["run", "serve"] };
    case "express":
      return { buildCmd: null, startCmd: ["run", "start"] };
    case "generic": {
      const buildCmd = hasScript(pkg, "build") ? ["run", "build"] : null;
      const startScript = GENERIC_START_SCRIPT_CANDIDATES.find((script) =>
        hasScript(pkg, script),
      );
      return {
        buildCmd,
        startCmd: ["run", startScript ?? "start"],
      };
    }
  }
}
