import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const { ensureRepo } = await import("../src/lib/git.js");

const target: SSHTarget = { host: "1.2.3.4", user: "root", port: 22 };

describe("ensureRepo", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  it("runs a clone-or-pull command over ssh with inherited stdio", async () => {
    execa.mockResolvedValueOnce({});

    await ensureRepo(target, {
      repo: "git@github.com:user/api.git",
      branch: "main",
      deployPath: "~/apps/api",
      service: "api",
    });

    expect(execa).toHaveBeenCalledWith(
      "ssh",
      [
        "-p",
        "22",
        "root@1.2.3.4",
        expect.stringContaining("git clone --branch \"main\""),
      ],
      { stdio: "inherit" },
    );
  });

  it("includes both the clone and pull branches referencing deployPath and repo", async () => {
    execa.mockResolvedValueOnce({});

    await ensureRepo(target, {
      repo: "git@github.com:user/api.git",
      branch: "develop",
      deployPath: "~/apps/api",
      service: "api",
    });

    const [, args] = execa.mock.calls[0];
    const remoteCommand = args[args.length - 1] as string;

    expect(remoteCommand).toContain('git reset --hard "origin/develop"');
    expect(remoteCommand).toContain(
      'git clone --branch "develop" "git@github.com:user/api.git" "~/apps/api"',
    );
  });

  it("exports GIT_SSH_COMMAND pointing at the service's deploy key for an SSH repo URL", async () => {
    execa.mockResolvedValueOnce({});

    await ensureRepo(target, {
      repo: "git@github.com:user/api.git",
      branch: "main",
      deployPath: "~/apps/api",
      service: "api",
    });

    const [, args] = execa.mock.calls[0];
    const remoteCommand = args[args.length - 1] as string;

    expect(remoteCommand).toContain("export GIT_SSH_COMMAND=");
    expect(remoteCommand).toContain("api_deploy_key");
    expect(remoteCommand).toContain("IdentitiesOnly=yes");
  });

  it("does not export GIT_SSH_COMMAND for a non-SSH repo URL", async () => {
    execa.mockResolvedValueOnce({});

    await ensureRepo(target, {
      repo: "https://github.com/user/api.git",
      branch: "main",
      deployPath: "~/apps/api",
      service: "api",
    });

    const [, args] = execa.mock.calls[0];
    const remoteCommand = args[args.length - 1] as string;

    expect(remoteCommand).not.toContain("GIT_SSH_COMMAND");
  });
});
