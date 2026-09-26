import { deployKeyPath } from "./deployKey.js";
import { applyNginxChanges, edgeRoutePath } from "./edge.js";
import { hasCertificate } from "./nginx.js";
import { sshExec } from "./ssh.js";
import type { SSHTarget } from "../types.js";

/** Removes the app's nginx site from its own server, plus the SNI route
 * deploy writes when that server is an edge (a no-op elsewhere). Runs
 * through the same nginx -t + rollback as deploys. */
export async function removeAppSite(
  target: SSHTarget,
  service: string,
  host: string,
): Promise<void> {
  await applyNginxChanges(target, [
    {
      path: `/etc/nginx/sites-available/${service}.conf`,
      remove: true,
      enableAs: `/etc/nginx/sites-enabled/${service}.conf`,
    },
    { path: edgeRoutePath(host), remove: true },
  ]);
}

/** Deletes the app's checkout. Refuses on the remote side if the path
 * resolves to something that's clearly not an app dir (empty, /, or $HOME
 * itself) — deployPath is user config, and this is an rm -rf. */
export async function removeDeployPath(
  target: SSHTarget,
  deployPath: string,
): Promise<void> {
  await sshExec(
    target,
    [
      `p="${deployPath}"`,
      `if [ -z "$p" ] || [ "$p" = "/" ] || [ "$p" = "$HOME" ] || [ "$p" = "$HOME/" ]; then echo "refusing to delete deploy_path '$p'" >&2; exit 1; fi`,
      `rm -rf "$p"`,
    ].join("; "),
  );
}

/** Deletes the host's Let's Encrypt certificate and its renewal config, if
 * one exists. Returns false if there was nothing to delete. Must run after
 * the nginx site referencing it is gone, or nginx -t would start failing. */
export async function deleteCertificate(
  target: SSHTarget,
  host: string,
): Promise<boolean> {
  if (!(await hasCertificate(target, host))) return false;
  await sshExec(
    target,
    `sudo certbot delete --cert-name "${host}" --non-interactive`,
  );
  return true;
}

export async function removeDeployKey(
  target: SSHTarget,
  service: string,
): Promise<void> {
  const keyPath = deployKeyPath(service);
  await sshExec(target, `rm -f "${keyPath}" "${keyPath}.pub"`);
}
