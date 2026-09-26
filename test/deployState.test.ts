import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeployConfig, SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const {
  clearDeployState,
  deployFingerprint,
  deployStatePath,
  readDeployState,
  shouldSkipDeploy,
  writeDeployState,
} = await import("../src/lib/deployState.js");
const { remoteBranchHead } = await import("../src/lib/git.js");

const target: SSHTarget = { host: "192.168.0.12", user: "root", port: 22 };
const A = "a".repeat(40);
const B = "b".repeat(40);

const config: DeployConfig = {
  service: "bob",
  repo: "git@github.com:chankruze/nodeploy-vite-demo.git",
  branch: "main",
  server: "192.168.0.12",
  ssh: { user: "root", port: 22 },
  deployPath: "$HOME/apps/bob",
  nodeVersion: "22",
  runtime: "node",
  proxy: { host: "bob.geekofia.cloud", ssl: {} },
};

function remoteCommand(call: number): string {
  const args = execa.mock.calls[call][1] as string[];
  return args[args.length - 1];
}

describe("deployFingerprint", () => {
  it("is stable for the same config", () => {
    expect(deployFingerprint(config)).toBe(deployFingerprint({ ...config }));
  });

  it("changes with any effective config change, e.g. enabling an edge or changing the port", () => {
    const base = deployFingerprint(config);
    expect(
      deployFingerprint({
        ...config,
        proxy: { ...config.proxy!, edge: { server: "192.168.0.8", ssh: config.ssh, upstream: "192.168.0.12" } },
      }),
    ).not.toBe(base);
    expect(deployFingerprint({ ...config, port: 3001 })).not.toBe(base);
  });
});

describe("shouldSkipDeploy", () => {
  const live = async () => true;
  const fp = deployFingerprint(config);
  const state = { commit: A, fingerprint: fp, kind: "static" as const };

  it("skips only when commit, fingerprint, and liveness all match", async () => {
    expect(await shouldSkipDeploy(state, A, fp, live)).toEqual({ skip: true, commit: A });
  });

  it("deploys on the first deploy (no record)", async () => {
    expect(await shouldSkipDeploy(null, A, fp, live)).toMatchObject({ skip: false, reason: "no previous deploy recorded" });
  });

  it("deploys a new commit, naming both", async () => {
    const decision = await shouldSkipDeploy(state, B, fp, live);
    expect(decision).toMatchObject({ skip: false });
    expect((decision as { reason: string }).reason).toBe("new commit bbbbbbb (deployed: aaaaaaa)");
  });

  it("deploys when the config or nodeploy version changed, same commit", async () => {
    expect(await shouldSkipDeploy(state, A, "different", live)).toMatchObject({
      skip: false,
      reason: expect.stringContaining("nodeploy.yml or nodeploy's version changed"),
    });
  });

  it("deploys when the app isn't running (e.g. after remove without --purge), checking liveness last", async () => {
    const isLive = vi.fn(async () => false);
    expect(await shouldSkipDeploy(state, A, fp, isLive)).toMatchObject({ skip: false, reason: "the app isn't running" });
    expect(isLive).toHaveBeenCalledWith("static");

    const notAsked = vi.fn(async () => true);
    await shouldSkipDeploy(state, B, fp, notAsked);
    expect(notAsked).not.toHaveBeenCalled();
  });

  it("deploys rather than guessing when the branch head can't be read", async () => {
    expect(await shouldSkipDeploy(state, null, fp, live)).toMatchObject({ skip: false });
  });
});

describe("deploy record on the server", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  it("lives inside .git/, out of reach of git reset/clean and git status", () => {
    expect(deployStatePath("$HOME/apps/bob")).toBe("$HOME/apps/bob/.git/nodeploy-deployed");
  });

  it("round-trips through write and read", async () => {
    execa.mockResolvedValueOnce({ stdout: "" });
    await writeDeployState(target, "$HOME/apps/bob", { commit: A, fingerprint: "f", kind: "pm2" });
    expect(remoteCommand(0)).toBe('cat > "$HOME/apps/bob/.git/nodeploy-deployed"');
    const written = execa.mock.calls[0][2].input as string;

    execa.mockResolvedValueOnce({ stdout: written.trim() });
    expect(await readDeployState(target, "$HOME/apps/bob")).toEqual({ commit: A, fingerprint: "f", kind: "pm2" });
  });

  it("treats a missing or malformed record as no record", async () => {
    execa.mockRejectedValueOnce(new Error("No such file"));
    expect(await readDeployState(target, "$HOME/apps/bob")).toBeNull();

    execa.mockResolvedValueOnce({ stdout: '{"commit":"x"}' });
    expect(await readDeployState(target, "$HOME/apps/bob")).toBeNull();

    execa.mockResolvedValueOnce({ stdout: "not json" });
    expect(await readDeployState(target, "$HOME/apps/bob")).toBeNull();
  });

  it("clears the record", async () => {
    execa.mockResolvedValueOnce({ stdout: "" });
    await clearDeployState(target, "$HOME/apps/bob");
    expect(remoteCommand(0)).toBe('rm -f "$HOME/apps/bob/.git/nodeploy-deployed"');
  });
});

describe("remoteBranchHead", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  it("asks the remote from the server, with the app's deploy key, without fetching", async () => {
    execa.mockResolvedValueOnce({ stdout: `${A}\trefs/heads/main\n` });

    expect(
      await remoteBranchHead(target, { repo: config.repo, branch: "main", service: "bob" }),
    ).toBe(A);
    const cmd = remoteCommand(0);
    expect(cmd).toContain(`export GIT_SSH_COMMAND='ssh -i "$HOME/.ssh/bob_deploy_key" -o IdentitiesOnly=yes'; `);
    expect(cmd).toContain(`git ls-remote "${config.repo}" "refs/heads/main"`);
  });

  it("returns null when the branch doesn't exist or the remote is unreachable", async () => {
    execa.mockResolvedValueOnce({ stdout: "" });
    expect(await remoteBranchHead(target, { repo: config.repo, branch: "nope", service: "bob" })).toBeNull();

    execa.mockRejectedValueOnce(new Error("Could not read from remote repository"));
    expect(await remoteBranchHead(target, { repo: config.repo, branch: "main", service: "bob" })).toBeNull();
  });
});
