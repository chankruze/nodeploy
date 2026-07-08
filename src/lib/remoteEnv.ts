export const NVM_DIR = "$HOME/.nvm";

/** Prefixes a remote command so nvm-installed node/npm/pm2 resolve even in a
 * non-login SSH shell, where ~/.bashrc/~/.profile aren't sourced automatically. */
export function withNvm(command: string): string {
  return `export NVM_DIR="${NVM_DIR}"; [ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh" > /dev/null 2>&1; ${command}`;
}
