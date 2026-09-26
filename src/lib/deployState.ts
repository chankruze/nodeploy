import { createHash } from "node:crypto";
import { version as nodeployVersion } from "../../package.json";
import { sshExec } from "./ssh.js";
import type { DeployConfig, SSHTarget } from "../types.js";

// What the last successful deploy put on the server, so an unchanged
// redeploy can be skipped. The app commit alone isn't enough: nodeploy.yml
// lives on the deploying machine, not in the checkout, and a newer nodeploy
// can write different nginx config for the same app — so the fingerprint
// covers the effective config and nodeploy's version too.

export interface DeployState {
  commit: string;
  fingerprint: string;
  /** How the app is served, i.e. how to tell whether it's still live. */
  kind: "pm2" | "static";
}

/** Inside .git/, where `git reset --hard` and `git clean` never touch it and
 * `git status` doesn't show it. Removed along with the checkout by --purge. */
export function deployStatePath(deployPath: string): string {
  return `${deployPath}/.git/nodeploy-deployed`;
}

export function deployFingerprint(config: DeployConfig): string {
  return createHash("sha256")
    .update(JSON.stringify({ nodeployVersion, config }))
    .digest("hex");
}

export async function readDeployState(
  target: SSHTarget,
  deployPath: string,
): Promise<DeployState | null> {
  try {
    const { stdout } = await sshExec(
      target,
      `cat "${deployStatePath(deployPath)}"`,
    );
    const state = JSON.parse(stdout) as Partial<DeployState>;
    if (
      typeof state.commit === "string" &&
      typeof state.fingerprint === "string" &&
      (state.kind === "pm2" || state.kind === "static")
    ) {
      return state as DeployState;
    }
    return null;
  } catch {
    return null;
  }
}

/** Only called once a deploy has fully succeeded, so a failed deploy never
 * leaves a state that makes the next one skip. */
export async function writeDeployState(
  target: SSHTarget,
  deployPath: string,
  state: DeployState,
): Promise<void> {
  await sshExec(target, `cat > "${deployStatePath(deployPath)}"`, {
    input: `${JSON.stringify(state)}\n`,
  });
}

export async function clearDeployState(
  target: SSHTarget,
  deployPath: string,
): Promise<void> {
  await sshExec(target, `rm -f "${deployStatePath(deployPath)}"`);
}

export type SkipDecision =
  | { skip: true; commit: string }
  | { skip: false; reason: string };

/** Decides whether a deploy would change nothing. `isLive` is only asked
 * once everything else matches, since it costs an extra remote call. */
export async function shouldSkipDeploy(
  state: DeployState | null,
  headCommit: string | null,
  fingerprint: string,
  isLive: (kind: DeployState["kind"]) => Promise<boolean>,
): Promise<SkipDecision> {
  if (!state) return { skip: false, reason: "no previous deploy recorded" };
  if (!headCommit) {
    return { skip: false, reason: "couldn't read the branch's latest commit" };
  }
  if (state.commit !== headCommit) {
    return {
      skip: false,
      reason: `new commit ${headCommit.slice(0, 7)} (deployed: ${state.commit.slice(0, 7)})`,
    };
  }
  if (state.fingerprint !== fingerprint) {
    return {
      skip: false,
      reason: "nodeploy.yml or nodeploy's version changed since the last deploy",
    };
  }
  if (!(await isLive(state.kind))) {
    return { skip: false, reason: "the app isn't running" };
  }
  return { skip: true, commit: headCommit };
}
