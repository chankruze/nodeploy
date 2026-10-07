import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeployConfig, SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const {
  checkDeployPathWritable,
  checkMemory,
  checkCertificate,
  checkCloudflareToken,
  checkEdgeProxyProtocolPort,
  checkEdgeRouting,
  checkEdgeUpstream,
  checkExternalAppPort,
  checkLocalEdgeRoute,
  checkNginx,
  checkNode,
  checkPM2,
  checkPython,
  checkPasswordlessSudo,
  checkSSHConnection,
  runAllChecks,
} = await import("../src/lib/doctorChecks.js");

const target: SSHTarget = {
  host: "203.0.113.10",
  user: "root",
  port: 22,
};

function makeConfig(overrides: Partial<DeployConfig> = {}): DeployConfig {
  return {
    service: "api",
    repo: "git@github.com:user/api.git",
    branch: "main",
    server: "203.0.113.10",
    ssh: { user: "root", port: 22 },
    deployPath: "~/apps/api",
    nodeVersion: "22",
    runtime: "node",
    ...overrides,
  };
}

describe("doctorChecks", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  it("checkSSHConnection returns ok when the connection succeeds", async () => {
    execa.mockResolvedValueOnce({});
    const result = await checkSSHConnection(target);
    expect(result.ok).toBe(true);
  });

  it("checkSSHConnection returns ok:false when the connection fails", async () => {
    execa.mockRejectedValueOnce(new Error("connection refused"));
    const result = await checkSSHConnection(target);
    expect(result.ok).toBe(false);
  });

  it("checkNode returns ok when node resolves on the remote", async () => {
    execa.mockResolvedValueOnce({ stdout: "v20.0.0\n" });
    const result = await checkNode(target);
    expect(result).toEqual({ name: "node", ok: true, message: "v20.0.0" });
  });

  it("checkPM2 returns ok:false and is required when pm2 is absent remotely", async () => {
    execa.mockRejectedValueOnce(new Error("command not found"));
    const result = await checkPM2(target);
    expect(result.ok).toBe(false);
    expect(result.optional).toBeUndefined();
  });

  it("checkNginx is optional and does not fail hard when absent", async () => {
    execa.mockRejectedValueOnce(new Error("command not found"));
    const result = await checkNginx(target);
    expect(result.ok).toBe(false);
    expect(result.optional).toBe(true);
  });

  it("checkMemory parses the Mem: line from remote `free -h`", async () => {
    execa.mockResolvedValueOnce({
      stdout: "              total   used   free\nMem:    7.6Gi  2.1Gi  1.2Gi\n",
    });
    const result = await checkMemory(target);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Mem:");
  });

  it("checkDeployPathWritable fails when the remote command fails", async () => {
    execa.mockRejectedValueOnce(new Error("permission denied"));
    const result = await checkDeployPathWritable(target, "~/apps/api");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not writable");
  });

  it("checkPasswordlessSudo fails when sudo -n fails", async () => {
    execa.mockRejectedValueOnce(new Error("sudo: a password is required"));
    const result = await checkPasswordlessSudo(target);
    expect(result.ok).toBe(false);
  });

  it("checkCertificate reports days left on a healthy cert", async () => {
    execa.mockResolvedValueOnce({ stdout: "notAfter=Dec 25 12:00:00 2026 GMT\n" });
    const result = await checkCertificate(
      target,
      "api.example.com",
      new Date("2026-09-26T12:00:00Z"),
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain("90 more day(s)");
  });

  it("checkCertificate fails hard when the cert is inside the renewal-failure window", async () => {
    execa.mockResolvedValueOnce({ stdout: "notAfter=Oct  1 12:00:00 2026 GMT" });
    const result = await checkCertificate(
      target,
      "api.example.com",
      new Date("2026-09-26T12:00:00Z"),
    );
    expect(result.ok).toBe(false);
    expect(result.optional).toBeUndefined();
    expect(result.message).toContain("expires in 5 day(s)");
  });

  it("checkCloudflareToken fails hard on a missing or rejected token", async () => {
    execa.mockResolvedValueOnce({ stdout: "" });
    execa.mockResolvedValueOnce({ stdout: '{"result":{"status":"active"},"success":true}' });
    expect((await checkCloudflareToken(target, "hr.example.com")).ok).toBe(true);

    execa.mockRejectedValueOnce(new Error("exit 1"));
    const missing = await checkCloudflareToken(target, "hr.example.com");
    expect(missing.ok).toBe(false);
    expect(missing.optional).toBeUndefined();
    expect(missing.message).toContain("CLOUDFLARE_API_TOKEN");

    execa.mockResolvedValueOnce({ stdout: "" });
    execa.mockResolvedValueOnce({ stdout: '{"success":false}' });
    const rejected = await checkCloudflareToken(target, "hr.example.com");
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toContain("before the next renewal");
  });

  it("checkCertificate is optional when no cert has been issued yet", async () => {
    execa.mockRejectedValueOnce(new Error("No such file"));
    const result = await checkCertificate(target, "api.example.com");
    expect(result.ok).toBe(false);
    expect(result.optional).toBe(true);
  });

  it("runAllChecks includes certbot and certificate checks only when proxy.ssl is set", async () => {
    execa.mockResolvedValue({ stdout: "notAfter=Dec 25 12:00:00 2099 GMT" });
    const plain = await runAllChecks(
      makeConfig({ proxy: { host: "api.example.com" }, port: 3000 }),
      target,
    );
    expect(plain.map((r) => r.name)).not.toContain("TLS certificate");

    const withSSL = await runAllChecks(
      makeConfig({ proxy: { host: "api.example.com", ssl: {} }, port: 3000 }),
      target,
    );
    const names = withSSL.map((r) => r.name);
    expect(names).toContain("certbot");
    expect(names).toContain("TLS certificate");
  });

  const edgeTarget: SSHTarget = { host: "192.168.0.8", user: "root", port: 22 };

  it("checkEdgeRouting is ok when router, site, and route are all present", async () => {
    execa.mockResolvedValueOnce({
      stdout: "router\nsite\nroute\nbob.example.com 192.168.0.12:8444;\n",
    });
    const result = await checkEdgeRouting(edgeTarget, "bob.example.com", "192.168.0.12", true);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("bob.example.com → 192.168.0.12 (http + https, real client IPs");
  });

  it("checkEdgeRouting flags an HTTPS route from before real-client-IP support", async () => {
    execa.mockResolvedValueOnce({
      stdout: "router\nsite\nroute\nbob.example.com 192.168.0.12:443;\n",
    });
    const result = await checkEdgeRouting(edgeTarget, "bob.example.com", "192.168.0.12", true);
    expect(result.ok).toBe(false);
    expect(result.optional).toBe(true);
    expect(result.message).toContain("without PROXY protocol");
  });

  it("checkEdgeRouting fails hard when HTTPS is on but the edge has no SNI router", async () => {
    execa.mockResolvedValueOnce({ stdout: "site\n" });
    const result = await checkEdgeRouting(edgeTarget, "bob.example.com", "192.168.0.12", true);
    expect(result.ok).toBe(false);
    expect(result.optional).toBeUndefined();
    expect(result.message).toContain("nodeploy setup");
  });

  it("checkEdgeRouting is optional before the first deploy writes the routes", async () => {
    execa.mockResolvedValueOnce({ stdout: "router\n" });
    const result = await checkEdgeRouting(edgeTarget, "bob.example.com", "192.168.0.12", true);
    expect(result.ok).toBe(false);
    expect(result.optional).toBe(true);
  });

  it("checkEdgeRouting doesn't need the SNI router or route for plain-HTTP apps", async () => {
    execa.mockResolvedValueOnce({ stdout: "site\n" });
    const result = await checkEdgeRouting(edgeTarget, "bob.example.com", "192.168.0.12", false);
    expect(result.ok).toBe(true);
  });

  it("checkEdgeUpstream passes on any HTTP response from the upstream, fails on 000", async () => {
    execa.mockResolvedValueOnce({ stdout: "404" });
    expect((await checkEdgeUpstream(edgeTarget, "bob.example.com", "192.168.0.12")).ok).toBe(true);

    execa.mockRejectedValueOnce(Object.assign(new Error("exit 7"), { stdout: "000" }));
    const result = await checkEdgeUpstream(edgeTarget, "bob.example.com", "192.168.0.12");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("can't reach 192.168.0.12:80");
  });

  it("checkLocalEdgeRoute is skipped (null) when the app's server isn't an edge", async () => {
    execa.mockResolvedValueOnce({ stdout: "" });
    expect(await checkLocalEdgeRoute(target, "payroll.example.com")).toBeNull();
  });

  it("checkLocalEdgeRoute is ok when the edge routes the host to the local TLS port", async () => {
    execa.mockResolvedValueOnce({
      stdout: "router\n# Managed by nodeploy.\npayroll.example.com 127.0.0.1:8444;\n",
    });
    const result = await checkLocalEdgeRoute(target, "payroll.example.com");
    expect(result?.ok).toBe(true);
  });

  it("checkLocalEdgeRoute flags a local route from before real-client-IP support", async () => {
    execa.mockResolvedValueOnce({ stdout: "router\npayroll.example.com 127.0.0.1:8443;\n" });
    const result = await checkLocalEdgeRoute(target, "payroll.example.com");
    expect(result?.ok).toBe(false);
    expect(result?.optional).toBe(true);
  });

  it("checkEdgeProxyProtocolPort checks the edge can open a TCP connection to upstream:8444", async () => {
    execa.mockResolvedValueOnce({ stdout: "" });
    const ok = await checkEdgeProxyProtocolPort(edgeTarget, "192.168.0.12");
    expect(ok.ok).toBe(true);
    const args = execa.mock.calls[0][1] as string[];
    expect(args[args.length - 1]).toBe("timeout 5 bash -c '</dev/tcp/192.168.0.12/8444'");

    execa.mockRejectedValueOnce(new Error("connection refused"));
    const failed = await checkEdgeProxyProtocolPort(edgeTarget, "192.168.0.12");
    expect(failed.ok).toBe(false);
    expect(failed.optional).toBe(true);
  });

  it("checkLocalEdgeRoute is optional when the edge has no route for the host yet", async () => {
    execa.mockResolvedValueOnce({ stdout: "router\n" });
    const result = await checkLocalEdgeRoute(target, "payroll.example.com");
    expect(result?.ok).toBe(false);
    expect(result?.optional).toBe(true);
  });

  it("runAllChecks drops the local edge check for ssl apps on non-edge servers", async () => {
    execa.mockResolvedValue({ stdout: "notAfter=Dec 25 12:00:00 2099 GMT" });
    const names = (
      await runAllChecks(makeConfig({ proxy: { host: "api.example.com", ssl: {} }, port: 3000 }), target)
    ).map((r) => r.name);
    expect(names).not.toContain("Edge routing");
  });

  it("runAllChecks includes edge checks only when proxy.edge is set", async () => {
    execa.mockResolvedValue({ stdout: "router\nsite\nroute" });
    const edge = { server: "192.168.0.8", ssh: { user: "root", port: 22 }, upstream: "192.168.0.12" };
    const names = (
      await runAllChecks(makeConfig({ proxy: { host: "bob.example.com", edge }, port: 3000 }), target)
    ).map((r) => r.name);
    expect(names).toContain("Edge routing");
    expect(names).toContain("Edge → upstream");
  });

  it("runAllChecks short-circuits to just the connection check when SSH fails", async () => {
    execa.mockRejectedValueOnce(new Error("connection refused"));
    const results = await runAllChecks(makeConfig(), target);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
  });

  it("runAllChecks always includes a sudo check", async () => {
    execa.mockResolvedValue({ stdout: "ok" });
    const results = await runAllChecks(
      makeConfig({ proxy: { host: "api.local" }, port: 3000 }),
      target,
    );
    expect(results.some((r) => r.name === "sudo")).toBe(true);
  });

  it("runAllChecks includes a sudo check even without proxy configured", async () => {
    execa.mockResolvedValue({ stdout: "ok" });
    const results = await runAllChecks(makeConfig(), target);
    expect(results.some((r) => r.name === "sudo")).toBe(true);
  });

  it("checkPython returns ok when python3 resolves on the remote", async () => {
    execa.mockResolvedValueOnce({ stdout: "Python 3.12.0\n" });
    const result = await checkPython(target);
    expect(result).toEqual({
      name: "python3",
      ok: true,
      message: "Python 3.12.0",
    });
  });

  it("runAllChecks includes a python check only when runtime is python", async () => {
    execa.mockResolvedValue({ stdout: "ok" });
    const nodeResults = await runAllChecks(makeConfig(), target);
    expect(nodeResults.some((r) => r.name === "python3")).toBe(false);

    const pythonResults = await runAllChecks(
      makeConfig({ runtime: "python", entry: "server.py" }),
      target,
    );
    expect(pythonResults.some((r) => r.name === "python3")).toBe(true);
  });

  it("checkExternalAppPort is ok when ss reports a listener, optional otherwise", async () => {
    execa.mockResolvedValueOnce({
      stdout: "LISTEN 0 4096 127.0.0.1:8090 0.0.0.0:*\n",
    });
    expect(await checkExternalAppPort(target, 8090)).toMatchObject({
      ok: true,
    });
    expect(execa.mock.calls[0][1].at(-1)).toBe('ss -Hltn "sport = :8090"');

    execa.mockResolvedValueOnce({ stdout: "" });
    expect(await checkExternalAppPort(target, 8090)).toMatchObject({
      ok: false,
      optional: true,
    });
  });

  it("runAllChecks swaps the Node/PM2/deploy path checks for a port check when runtime is external", async () => {
    execa.mockResolvedValue({ stdout: "ok" });
    const results = await runAllChecks(
      makeConfig({
        runtime: "external",
        repo: "",
        port: 8090,
        proxy: { host: "api.example.com" },
      }),
      target,
    );
    const names = results.map((r) => r.name);
    expect(names).toContain("App port");
    expect(names).toContain("nginx");
    expect(names).toContain("sudo");
    for (const skipped of ["node", "npm", "pnpm", "pm2", "Deploy path"]) {
      expect(names).not.toContain(skipped);
    }
  });
});
