import { sshExec } from "./ssh.js";
import type { SSHTarget } from "../types.js";

export function buildServerBlock(
  service: string,
  host: string,
  port: number,
): string {
  return `server {
    listen 80;
    server_name ${host};

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
}

export function buildStaticServerBlock(host: string, root: string): string {
  return `server {
    listen 80;
    server_name ${host};

    root ${root};
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
`;
}

async function writeAndReload(
  target: SSHTarget,
  service: string,
  block: string,
): Promise<void> {
  const available = `/etc/nginx/sites-available/${service}.conf`;
  const enabled = `/etc/nginx/sites-enabled/${service}.conf`;

  const remoteCommand = [
    `sudo tee "${available}" > /dev/null`,
    `sudo ln -sf "${available}" "${enabled}"`,
    "sudo nginx -t",
    "sudo systemctl reload nginx",
  ].join(" && ");

  await sshExec(target, remoteCommand, { input: block });
}

export async function deployProxyConfig(
  target: SSHTarget,
  service: string,
  host: string,
  port: number,
): Promise<void> {
  await writeAndReload(target, service, buildServerBlock(service, host, port));
}

export async function deployStaticProxyConfig(
  target: SSHTarget,
  service: string,
  host: string,
  root: string,
): Promise<void> {
  // nginx's worker runs as www-data, not the SSH user — if deploy_path defaults
  // to ~/apps/<service> under a root-owned $HOME (mode 700), www-data can't
  // traverse into it to serve the static build, which nginx surfaces as a
  // rewrite/redirection cycle (or a plain 500) rather than a clear permission
  // error. Grant traversal only, not read/listing, on $HOME itself.
  await sshExec(target, "chmod o+x $HOME");
  await writeAndReload(target, service, buildStaticServerBlock(host, root));
}

export async function isStaticSiteEnabled(
  target: SSHTarget,
  service: string,
): Promise<boolean> {
  try {
    await sshExec(target, `test -f "/etc/nginx/sites-enabled/${service}.conf"`);
    return true;
  } catch {
    return false;
  }
}
