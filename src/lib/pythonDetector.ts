import { sshExec } from "./ssh.js";
import type { PythonAppType, SSHTarget } from "../types.js";

export interface PythonManifest {
  hasRequirementsTxt: boolean;
  hasPyprojectToml: boolean;
  /** Contents of requirements.txt/pyproject.toml, if present — searched for a Flask marker. */
  manifestContent: string;
}

/**
 * Python has no single "scripts"/"dependencies" file like package.json, so
 * detection is a best-effort scan of whichever manifest exists for a Flask
 * marker. Anything else (including apps with no manifest at all, e.g. a
 * pure-stdlib http.server script) falls back to "python" — a plain
 * interpreter invocation with no extra install step beyond the venv itself.
 */
export function detectPythonAppType(manifest: PythonManifest): PythonAppType {
  if (/^\s*flask\b/im.test(manifest.manifestContent)) return "flask";
  return "python";
}

/**
 * Every Python app gets a venv (for isolation, even with zero dependencies);
 * this only decides whether a `pip install` step also runs inside it.
 */
export function resolvePythonInstallCmd(
  manifest: PythonManifest,
  venvPath: string,
): string[] {
  const venvSetup = `python3 -m venv "${venvPath}"`;
  const pip = `${venvPath}/bin/pip`;

  if (manifest.hasRequirementsTxt) {
    return [
      `${venvSetup} && "${pip}" install --upgrade pip -q && "${pip}" install -r requirements.txt`,
    ];
  }

  if (manifest.hasPyprojectToml) {
    return [
      `${venvSetup} && "${pip}" install --upgrade pip -q && "${pip}" install .`,
    ];
  }

  return [venvSetup];
}

/** Reads whichever manifest file exists in deployPath on the server, if any. */
export async function fetchPythonManifest(
  target: SSHTarget,
  deployPath: string,
): Promise<PythonManifest> {
  const remoteCommand = [
    `if [ -f "${deployPath}/requirements.txt" ]; then`,
    `echo REQUIREMENTS_TXT; cat "${deployPath}/requirements.txt";`,
    `elif [ -f "${deployPath}/pyproject.toml" ]; then`,
    `echo PYPROJECT_TOML; cat "${deployPath}/pyproject.toml";`,
    "else",
    "echo NONE;",
    "fi",
  ].join(" ");

  const { stdout } = await sshExec(target, remoteCommand);
  const [marker, ...rest] = stdout.split("\n");
  const manifestContent = rest.join("\n");

  return {
    hasRequirementsTxt: marker?.trim() === "REQUIREMENTS_TXT",
    hasPyprojectToml: marker?.trim() === "PYPROJECT_TOML",
    manifestContent,
  };
}
