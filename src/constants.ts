export const DEPLOY_CONFIG_FILENAME = "nodeploy.yml";

export const DEFAULT_SSH_PORT = 22;

export const DEFAULT_BRANCH = "main";

export const DEFAULT_NODE_VERSION = "22";

export const DEFAULT_RUNTIME = "node";

/** Local env var `nodeploy setup` reads a Cloudflare API token from, for
 * `proxy.ssl.dns: cloudflare`. Never stored in nodeploy.yml. */
export const CLOUDFLARE_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";

/** Log rotation every PM2 app gets unless nodeploy.yml's `log_rotation`
 * overrides it. */
export const DEFAULT_LOG_ROTATION = {
  enabled: true,
  maxSize: "50M",
  retain: 7,
  compress: true,
  interval: 30,
} as const;

/** Credits in the emails nodeploy sends (backup notifications). */
export const NODEPLOY_CREDIT = "Chandan Kumar Mandal";
export const NODEPLOY_URL = "https://github.com/chankruze/nodeploy";

/** Local env var `nodeploy backup setup` reads the SMTP password from, for
 * backup emails. Never stored in nodeploy.yml. */
export const SMTP_PASSWORD_ENV = "NODEPLOY_SMTP_PASSWORD";
