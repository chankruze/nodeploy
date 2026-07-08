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

export async function deployProxyConfig(
  target: SSHTarget,
  service: string,
  host: string,
  port: number,
): Promise<void> {
  const block = buildServerBlock(service, host, port);
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
