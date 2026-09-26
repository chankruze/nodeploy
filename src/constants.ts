export const DEPLOY_CONFIG_FILENAME = "nodeploy.yml";

export const DEFAULT_SSH_PORT = 22;

export const DEFAULT_BRANCH = "main";

export const DEFAULT_NODE_VERSION = "22";

export const DEFAULT_RUNTIME = "node";

/** Local env var `nodeploy setup` reads a Cloudflare API token from, for
 * `proxy.ssl.dns: cloudflare`. Never stored in nodeploy.yml. */
export const CLOUDFLARE_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";
