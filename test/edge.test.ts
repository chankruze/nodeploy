import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SSHTarget } from "../src/types.js";

const { execa } = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa }));

const {
  EDGE_STREAM_CONF,
  bootstrapEdge,
  buildApplyScript,
  buildEdgeHttpForward,
  buildEdgeRoute,
  buildEdgeStreamConfig,
  deployEdgeRoute,
  findPort443Conflicts,
  localizeNodeploySite,
  planLocalTLSMigration,
} = await import("../src/lib/edge.js");
const { buildServerBlock } = await import("../src/lib/nginx.js");

const edge: SSHTarget = { host: "192.168.0.8", user: "root", port: 22 };

function remoteCommand(call: number): string {
  const args = execa.mock.calls[call][1] as string[];
  return args[args.length - 1];
}

function scriptInput(call: number): string {
  return execa.mock.calls[call][2].input as string;
}

describe("edge config builders", () => {
  it("forwards plain HTTP for the host to the upstream's nginx, preserving Host", () => {
    const block = buildEdgeHttpForward("bob.geekofia.cloud", "192.168.0.12");

    expect(block).toContain("listen 80;");
    expect(block).toContain("server_name bob.geekofia.cloud;");
    expect(block).toContain("proxy_pass http://192.168.0.12;");
    expect(block).toContain("proxy_set_header Host $host;");
  });

  it("routes a hostname to an upstream address", () => {
    expect(buildEdgeRoute("bob.geekofia.cloud", "192.168.0.12:443")).toContain(
      "bob.geekofia.cloud 192.168.0.12:443;",
    );
  });

  it("builds an SNI router that includes per-host routes and supports wildcard hosts", () => {
    const conf = buildEdgeStreamConfig();

    expect(conf).toContain("map $ssl_preread_server_name $nodeploy_upstream {");
    expect(conf).toContain("hostnames;");
    expect(conf).toContain("include /etc/nginx/stream.d/nodeploy-routes/*.conf;");
    expect(conf).toContain("default 127.0.0.1:8443;");
    expect(conf).toContain("listen 443;");
    expect(conf).toContain("ssl_preread on;");
  });
});

describe("findPort443Conflicts", () => {
  const dump = `# configuration file /etc/nginx/nginx.conf:
http {
}
# configuration file /etc/nginx/sites-enabled/default:
server {
	listen 80 default_server;
	# listen 443 ssl default_server;
}
# configuration file /etc/nginx/sites-enabled/shop.conf:
server {
    listen [::]:443 ssl;
}
# configuration file /etc/nginx/stream.d/sni-passthrough.conf:
server {
    listen 443;
}
# configuration file /etc/nginx/sites-enabled/local-tls.conf:
server {
    listen 127.0.0.1:8443 ssl;
}
# configuration file ${"/etc/nginx/stream.d/nodeploy.conf"}:
server {
    listen 443;
}
`;

  it("reports active 443 listeners in other files, ignoring comments, 8443, and its own file", () => {
    expect(findPort443Conflicts(dump, EDGE_STREAM_CONF)).toEqual([
      "/etc/nginx/sites-enabled/shop.conf",
      "/etc/nginx/stream.d/sni-passthrough.conf",
    ]);
  });
});

describe("localizeNodeploySite", () => {
  it("moves a nodeploy HTTPS site from 443 to the local TLS port, keeping everything else", () => {
    const site = buildServerBlock("payroll.example.com", 8080, true);
    const result = localizeNodeploySite(site);

    expect(result?.host).toBe("payroll.example.com");
    expect(result?.content).toBe(
      site.replace("listen 443 ssl http2;", "listen 127.0.0.1:8443 ssl http2;"),
    );
  });

  it("leaves alone anything that isn't the exact shape nodeploy writes", () => {
    // Hand-written TLS site: different listen form, non-letsencrypt cert.
    expect(
      localizeNodeploySite(
        "server {\n    listen 443 ssl;\n    server_name shop.example.com;\n    ssl_certificate /etc/ssl/shop.pem;\n}\n",
      ),
    ).toBeNull();
    // nodeploy's shape plus an extra IPv6 443 listener someone added.
    const tweaked = buildServerBlock("payroll.example.com", 8080, true).replace(
      "listen 443 ssl http2;",
      "listen 443 ssl http2;\n    listen [::]:443 ssl http2;",
    );
    expect(localizeNodeploySite(tweaked)).toBeNull();
    // Plain-HTTP nodeploy site: nothing on 443 to move.
    expect(localizeNodeploySite(buildServerBlock("a.example.com", 3000))).toBeNull();
  });
});

describe("planLocalTLSMigration", () => {
  it("moves nodeploy HTTPS sites to the local TLS port with a route each, and reports anything else as foreign", () => {
    const payroll = buildServerBlock("payroll.example.com", 8080, true);
    const dump = [
      "# configuration file /etc/nginx/sites-enabled/payroll.conf:",
      payroll,
      "# configuration file /etc/nginx/sites-enabled/shop.conf:",
      "server {\n    listen 443 ssl;\n    server_name shop.example.com;\n}",
      "# configuration file /etc/nginx/sites-enabled/plain.conf:",
      buildServerBlock("plain.example.com", 3000),
    ].join("\n");

    const plan = planLocalTLSMigration(dump);

    expect(plan.hosts).toEqual(["payroll.example.com"]);
    expect(plan.foreign).toEqual(["/etc/nginx/sites-enabled/shop.conf"]);
    expect(plan.ops).toHaveLength(2);
    expect(plan.ops[0]).toMatchObject({ path: "/etc/nginx/sites-enabled/payroll.conf" });
    expect((plan.ops[0] as { content: string }).content).toContain(
      "listen 127.0.0.1:8443 ssl http2;",
    );
    expect(plan.ops[1]).toEqual({
      path: "/etc/nginx/stream.d/nodeploy-routes/payroll.example.com.conf",
      content: "# Managed by nodeploy.\npayroll.example.com 127.0.0.1:8443;\n",
    });
  });
});

describe("buildApplyScript", () => {
  it("validates with nginx -t before reloading, and restores on failure", () => {
    const script = buildApplyScript([
      { path: "/etc/a.conf", content: "a\n", enableAs: "/etc/enabled/a.conf" },
    ]);

    expect(script).toContain("trap 'restore; exit 1' ERR");
    expect(script).toMatch(/if ! sudo nginx -t; then\n {2}restore\n {2}exit 1\nfi\nsudo systemctl reload nginx/);
    expect(script).toContain('sudo cp -p "/etc/a.conf" "/etc/a.conf.nodeploy-prev"');
    expect(script).toContain('sudo ln -sf "/etc/a.conf" "/etc/enabled/a.conf"');
    expect(script).toContain(
      'if [ -e "/etc/a.conf.nodeploy-prev" ]; then sudo cp -p "/etc/a.conf.nodeploy-prev" "/etc/a.conf"; sudo rm -f "/etc/a.conf.nodeploy-prev"; else sudo rm -f "/etc/a.conf"; fi',
    );
  });

  it("only appends when the marker is missing", () => {
    const script = buildApplyScript([
      { path: "/etc/nginx/nginx.conf", appendIfMissing: { marker: "include x;", content: "stream { include x; }\n" } },
    ]);

    expect(script).toContain("if ! sudo grep -qF 'include x;' \"/etc/nginx/nginx.conf\"; then");
    expect(script).toContain('sudo tee -a "/etc/nginx/nginx.conf"');
  });
});

describe("deployEdgeRoute", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  it("with ssl, writes the HTTP forward and the SNI route in one transactional apply", async () => {
    execa.mockResolvedValue({ stdout: "" });

    await deployEdgeRoute(edge, "bob.geekofia.cloud", "192.168.0.12", true);

    expect(execa).toHaveBeenCalledTimes(2);
    expect(remoteCommand(0)).toBe(`test -f "${EDGE_STREAM_CONF}"`);
    expect(remoteCommand(1)).toBe("bash -s");

    const script = scriptInput(1);
    expect(script).toContain('sudo tee "/etc/nginx/sites-available/edge.bob.geekofia.cloud.conf"');
    expect(script).toContain(
      'sudo ln -sf "/etc/nginx/sites-available/edge.bob.geekofia.cloud.conf" "/etc/nginx/sites-enabled/edge.bob.geekofia.cloud.conf"',
    );
    expect(script).toContain("proxy_pass http://192.168.0.12;");
    expect(script).toContain('sudo tee "/etc/nginx/stream.d/nodeploy-routes/bob.geekofia.cloud.conf"');
    expect(script).toContain("bob.geekofia.cloud 192.168.0.12:443;");
  });

  it("without ssl, writes only the HTTP forward and removes any stale SNI route", async () => {
    execa.mockResolvedValue({ stdout: "" });

    await deployEdgeRoute(edge, "bob.geekofia.cloud", "192.168.0.12", false);

    expect(execa).toHaveBeenCalledTimes(1);
    const script = scriptInput(0);
    expect(script).toContain("proxy_pass http://192.168.0.12;");
    expect(script).toContain('sudo rm -f "/etc/nginx/stream.d/nodeploy-routes/bob.geekofia.cloud.conf"');
    expect(script).not.toContain(":443;");
  });

  it("with ssl, refuses to write routes before the edge is bootstrapped", async () => {
    execa.mockRejectedValueOnce(new Error("exit 1"));

    await expect(
      deployEdgeRoute(edge, "bob.geekofia.cloud", "192.168.0.12", true),
    ).rejects.toThrow(/run `nodeploy setup` first/);
    expect(execa).toHaveBeenCalledTimes(1);
  });
});

describe("bootstrapEdge", () => {
  beforeEach(() => {
    execa.mockReset();
  });

  it("adds the top-level stream include and the SNI router", async () => {
    execa.mockResolvedValueOnce({ stdout: "# configuration file /etc/nginx/nginx.conf:\nhttp {}\n" });
    execa.mockResolvedValue({ stdout: "" });

    await bootstrapEdge(edge);

    expect(remoteCommand(0)).toBe("sudo nginx -T 2>/dev/null");
    expect(remoteCommand(1)).toBe('sudo mkdir -p "/etc/nginx/stream.d/nodeploy-routes"');
    const script = scriptInput(2);
    expect(script).toContain("if ! sudo grep -qF 'include /etc/nginx/stream.d/*.conf;' \"/etc/nginx/nginx.conf\"; then");
    expect(script).toContain(`sudo tee "${EDGE_STREAM_CONF}"`);
    expect(script).toContain("ssl_preread on;");
  });

  it("moves nodeploy HTTPS apps already on the box to the local TLS port in the same apply", async () => {
    execa.mockResolvedValueOnce({
      stdout: `# configuration file /etc/nginx/sites-enabled/payroll.conf:\n${buildServerBlock("payroll.example.com", 8080, true)}`,
    });
    execa.mockResolvedValue({ stdout: "" });

    const moved = await bootstrapEdge(edge);

    expect(moved).toEqual(["payroll.example.com"]);
    const script = scriptInput(2);
    expect(script).toContain(`sudo tee "${EDGE_STREAM_CONF}"`);
    expect(script).toContain('sudo tee "/etc/nginx/sites-enabled/payroll.conf"');
    expect(script).toContain("listen 127.0.0.1:8443 ssl http2;");
    expect(script).toContain("payroll.example.com 127.0.0.1:8443;");
  });

  it("refuses when something else already listens on 443, naming the file", async () => {
    execa.mockResolvedValueOnce({
      stdout: "# configuration file /etc/nginx/stream.d/sni-passthrough.conf:\nserver {\n    listen 443;\n}\n",
    });

    await expect(bootstrapEdge(edge)).rejects.toThrow(
      /already used by \/etc\/nginx\/stream.d\/sni-passthrough.conf/,
    );
    expect(execa).toHaveBeenCalledTimes(1);
  });
});
