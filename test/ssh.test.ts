import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const { buildSSHArgs, resolveHomePath, sshExec, sshTest } = await import(
  "../src/lib/ssh.js"
);

describe("buildSSHArgs", () => {
  it("builds args with port and user@host, no keys", () => {
    const target: SSHTarget = { host: "1.2.3.4", user: "root", port: 22 };
    expect(buildSSHArgs(target)).toEqual(["-p", "22", "root@1.2.3.4"]);
  });

  it("adds -i for each configured key", () => {
    const target: SSHTarget = {
      host: "1.2.3.4",
      user: "root",
      port: 2222,
      keys: ["~/.ssh/id_ed25519", "~/.ssh/other"],
    };
    expect(buildSSHArgs(target)).toEqual([
      "-p",
      "2222",
      "-i",
      "~/.ssh/id_ed25519",
      "-i",
      "~/.ssh/other",
      "root@1.2.3.4",
    ]);
  });
});

describe("sshExec", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  const target: SSHTarget = { host: "1.2.3.4", user: "root", port: 22 };

  it("runs the remote command over ssh with default options", async () => {
    execa.mockResolvedValueOnce({ stdout: "hello" });
    const result = await sshExec(target, "echo hello");

    expect(execa).toHaveBeenCalledWith(
      "ssh",
      ["-p", "22", "root@1.2.3.4", "echo hello"],
      {},
    );
    expect(result).toEqual({ stdout: "hello" });
  });

  it("passes stdio and input through to execa", async () => {
    execa.mockResolvedValueOnce({});
    await sshExec(target, "cat > file", { input: "contents" });

    expect(execa).toHaveBeenCalledWith(
      "ssh",
      ["-p", "22", "root@1.2.3.4", "cat > file"],
      { input: "contents" },
    );
  });
});

describe("sshTest", () => {
  const target: SSHTarget = { host: "1.2.3.4", user: "root", port: 22 };

  beforeEach(() => {
    execa.mockReset();
  });

  it("returns true when the connection succeeds", async () => {
    execa.mockResolvedValueOnce({});
    await expect(sshTest(target)).resolves.toBe(true);
  });

  it("returns false when the connection fails", async () => {
    execa.mockRejectedValueOnce(new Error("connection refused"));
    await expect(sshTest(target)).resolves.toBe(false);
  });
});

describe("resolveHomePath", () => {
  const target: SSHTarget = { host: "1.2.3.4", user: "root", port: 22 };

  beforeEach(() => {
    execa.mockReset();
  });

  it("replaces a $HOME prefix with the real remote home directory", async () => {
    execa.mockResolvedValueOnce({ stdout: "/root\n" });
    await expect(
      resolveHomePath(target, "$HOME/apps/api/dist"),
    ).resolves.toBe("/root/apps/api/dist");
  });

  it("replaces a ~ prefix with the real remote home directory", async () => {
    execa.mockResolvedValueOnce({ stdout: "/home/deploy\n" });
    await expect(resolveHomePath(target, "~/apps/api/dist")).resolves.toBe(
      "/home/deploy/apps/api/dist",
    );
  });

  it("leaves an already-absolute path untouched, without querying the remote", async () => {
    await expect(resolveHomePath(target, "/srv/api/dist")).resolves.toBe(
      "/srv/api/dist",
    );
    expect(execa).not.toHaveBeenCalled();
  });
});
