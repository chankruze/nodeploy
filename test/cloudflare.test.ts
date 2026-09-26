import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const {
  cloudflareCredentialsPath,
  ensureCertbotDnsCloudflare,
  verifyCloudflareToken,
  writeCloudflareCredentials,
} = await import("../src/lib/cloudflare.js");

const target: SSHTarget = { host: "192.168.0.12", user: "root", port: 22 };
const TOKEN = "AbCdEf0123456789_ghIJ-klmnopqrstu";

function remoteCommand(call: number): string {
  const args = execa.mock.calls[call][1] as string[];
  return args[args.length - 1];
}

describe("cloudflare", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  it("keeps one root-only credentials file per host", () => {
    expect(cloudflareCredentialsPath("hr.geekofia.cloud")).toBe(
      "/etc/letsencrypt/nodeploy/cloudflare-hr.geekofia.cloud.ini",
    );
  });

  it("writes the token over stdin, never on the command line, into a umask-077 file", async () => {
    execa.mockResolvedValue({ stdout: "" });

    await writeCloudflareCredentials(target, "hr.geekofia.cloud", TOKEN);

    const cmd = remoteCommand(0);
    expect(cmd).not.toContain(TOKEN);
    expect(cmd).toContain('sudo chmod 700 "/etc/letsencrypt/nodeploy"');
    expect(cmd).toContain(
      `sudo sh -c 'umask 077; cat > "/etc/letsencrypt/nodeploy/cloudflare-hr.geekofia.cloud.ini"'`,
    );
    expect(execa.mock.calls[0][2].input).toContain(`dns_cloudflare_api_token = ${TOKEN}\n`);
  });

  it("rejects something that isn't a token before sending anything", async () => {
    await expect(
      writeCloudflareCredentials(target, "hr.geekofia.cloud", "not a token\nx = y"),
    ).rejects.toThrow(/doesn't look like a Cloudflare API token/);
    expect(execa).not.toHaveBeenCalled();
  });

  it("installs the apt Cloudflare plugin only when it can't be imported", async () => {
    execa.mockResolvedValueOnce({ stdout: "" });
    expect(await ensureCertbotDnsCloudflare(target)).toBe(false);

    execa.mockRejectedValueOnce(new Error("ModuleNotFoundError"));
    execa.mockResolvedValueOnce({ stdout: "" });
    expect(await ensureCertbotDnsCloudflare(target)).toBe(true);
    expect(remoteCommand(2)).toContain("apt-get install -y python3-certbot-dns-cloudflare");
  });

  it("verifies the stored token with Cloudflare without putting it in any process's arguments", async () => {
    execa.mockResolvedValueOnce({ stdout: "" }); // credentials present
    execa.mockResolvedValueOnce({
      stdout: '{"result":{"id":"x","status":"active"},"success":true,"errors":[]}',
    });

    expect(await verifyCloudflareToken(target, "hr.geekofia.cloud")).toBe("active");
    const cmd = remoteCommand(1);
    expect(cmd).toContain('printf "Authorization: Bearer %s\\n" "$t" | curl -s -m 10 -H @-');
    expect(cmd).toContain("https://api.cloudflare.com/client/v4/user/tokens/verify");
  });

  it("reports missing and invalid tokens", async () => {
    execa.mockRejectedValueOnce(new Error("exit 1"));
    expect(await verifyCloudflareToken(target, "hr.geekofia.cloud")).toBe("missing");

    execa.mockResolvedValueOnce({ stdout: "" });
    execa.mockResolvedValueOnce({ stdout: '{"success":false,"errors":[{"code":1000,"message":"Invalid API Token"}]}' });
    expect(await verifyCloudflareToken(target, "hr.geekofia.cloud")).toBe("invalid");
  });
});
