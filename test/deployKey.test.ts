import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const { deployKeyPath, ensureDeployKey, parseGitSSHHost } = await import(
  "../src/lib/deployKey.js"
);

describe("parseGitSSHHost", () => {
  it("extracts the host from an scp-like git@host:path URL", () => {
    expect(parseGitSSHHost("git@github.com:user/api.git")).toBe("github.com");
  });

  it("extracts the host from an ssh:// URL", () => {
    expect(parseGitSSHHost("ssh://git@github.com/user/api.git")).toBe(
      "github.com",
    );
  });

  it("returns null for an https URL", () => {
    expect(parseGitSSHHost("https://github.com/user/api.git")).toBeNull();
  });
});

describe("deployKeyPath", () => {
  it("scopes the key path to the service name", () => {
    expect(deployKeyPath("my-app")).toBe("$HOME/.ssh/my-app_deploy_key");
  });
});

describe("ensureDeployKey", () => {
  const target: SSHTarget = { host: "1.2.3.4", user: "root", port: 22 };

  beforeEach(() => {
    execa.mockReset();
  });

  it("reports created=true and returns the pubkey when generating a new key", async () => {
    execa.mockResolvedValueOnce({
      stdout: "CREATED\nssh-ed25519 AAAA... my-app-deploy-key",
    });

    const result = await ensureDeployKey(target, "my-app", "github.com");

    expect(result).toEqual({
      publicKey: "ssh-ed25519 AAAA... my-app-deploy-key",
      created: true,
    });
    const [, args] = execa.mock.calls[0];
    const remoteCommand = args[args.length - 1] as string;
    expect(remoteCommand).toContain("ssh-keygen -t ed25519");
    expect(remoteCommand).toContain("my-app_deploy_key");
    expect(remoteCommand).toContain("ssh-keyscan -H \"github.com\"");
  });

  it("reports created=false and returns the existing pubkey when one is already present", async () => {
    execa.mockResolvedValueOnce({
      stdout: "EXISTS\nssh-ed25519 AAAA... my-app-deploy-key",
    });

    const result = await ensureDeployKey(target, "my-app", "github.com");

    expect(result).toEqual({
      publicKey: "ssh-ed25519 AAAA... my-app-deploy-key",
      created: false,
    });
  });
});
