import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const { deleteCertificate, removeAppSite, removeDeployKey, removeDeployPath } =
  await import("../src/lib/remove.js");

const target: SSHTarget = { host: "192.168.0.12", user: "root", port: 22 };

function remoteCommand(call: number): string {
  const args = execa.mock.calls[call][1] as string[];
  return args[args.length - 1];
}

describe("remove helpers", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  it("removeAppSite removes the site, its symlink, and any local SNI route, transactionally", async () => {
    execa.mockResolvedValue({ stdout: "" });

    await removeAppSite(target, "bob", "bob.geekofia.cloud");

    expect(remoteCommand(0)).toBe("bash -s");
    const script = execa.mock.calls[0][2].input as string;
    expect(script).toContain('sudo rm -f "/etc/nginx/sites-available/bob.conf"');
    expect(script).toContain('sudo rm -f "/etc/nginx/sites-enabled/bob.conf"');
    expect(script).toContain('sudo rm -f "/etc/nginx/stream.d/nodeploy-routes/bob.geekofia.cloud.conf"');
    expect(script).toContain("if ! sudo nginx -t; then");
  });

  it("removeDeployPath guards against deleting /, $HOME, or an empty path before rm -rf", async () => {
    execa.mockResolvedValue({ stdout: "" });

    await removeDeployPath(target, "$HOME/apps/bob");

    const cmd = remoteCommand(0);
    expect(cmd).toContain('p="$HOME/apps/bob"');
    expect(cmd).toContain('[ -z "$p" ] || [ "$p" = "/" ] || [ "$p" = "$HOME" ]');
    expect(cmd.indexOf("refusing")).toBeLessThan(cmd.indexOf('rm -rf "$p"'));
  });

  it("deleteCertificate deletes via certbot when a cert exists", async () => {
    execa.mockResolvedValue({ stdout: "" });

    expect(await deleteCertificate(target, "bob.geekofia.cloud")).toBe(true);
    expect(remoteCommand(1)).toBe(
      'sudo certbot delete --cert-name "bob.geekofia.cloud" --non-interactive',
    );
  });

  it("deleteCertificate is a no-op when there's no cert", async () => {
    execa.mockRejectedValueOnce(new Error("exit 1"));

    expect(await deleteCertificate(target, "bob.geekofia.cloud")).toBe(false);
    expect(execa).toHaveBeenCalledTimes(1);
  });

  it("removeDeployKey deletes both halves of the key", async () => {
    execa.mockResolvedValue({ stdout: "" });

    await removeDeployKey(target, "bob");

    expect(remoteCommand(0)).toBe(
      'rm -f "$HOME/.ssh/bob_deploy_key" "$HOME/.ssh/bob_deploy_key.pub"',
    );
  });
});
