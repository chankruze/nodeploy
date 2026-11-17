import { gitSshEnv } from "./git.js";
import { shellQuote } from "./logRotation.js";
import { sshExec } from "./ssh.js";
import type { SSHTarget } from "../types.js";

// `nodeploy deploy` syncs the checkout with `git reset --hard`, which throws
// away anything changed on the server since the last deploy. For code that's
// the point; for app data committed to the repo (a SQLite database, a JSON
// store) it silently rolls the data back to whatever was committed. So
// before syncing, deploy asks the server which files the reset would
// actually change, and stops unless told what to do with them.

/** What `git reset --hard origin/<branch>` would do to a file the server
 * changed: `overwritten` — the new commit has a different version;
 * `deleted` — the new commit doesn't have it; `same` — the server's copy
 * already matches the new commit (e.g. after `nodeploy pull-files` and a
 * push), so nothing is lost. */
export type ChangeKind = "overwritten" | "deleted" | "same";

export interface ServerChange {
  path: string;
  kind: ChangeKind;
  /** False for an untracked file the new commit adds at the same path. */
  tracked: boolean;
}

export interface ServerChanges {
  head: string;
  target: string;
  changes: ServerChange[];
}

export interface RepoLocation {
  repo: string;
  branch: string;
  deployPath: string;
  service: string;
}

/** Fetches the branch and reports, one per line:
 * `CHANGE <kind> <tracked|untracked> <path>`. Prints NOREPO for a server
 * without a checkout yet (the first deploy clones, nothing to lose). */
export function inspectScript(deployPath: string, branch: string): string {
  return `set -u
cd "${deployPath}" 2>/dev/null && [ -d .git ] || { echo NOREPO; exit 0; }
git fetch -q origin ${shellQuote(branch)} || exit 4
T=${shellQuote(`origin/${branch}`)}
printf 'HEAD\\t%s\\nTARGET\\t%s\\n' "$(git rev-parse HEAD)" "$(git rev-parse "$T")"
check() {
  [ -f "$1" ] || return 0
  want=$(git rev-parse -q --verify "$T:$1" 2>/dev/null) || want=""
  have=$(git hash-object -- "$1")
  if [ -z "$want" ]; then kind=deleted
  elif [ "$want" = "$have" ]; then kind=same
  else kind=overwritten; fi
  printf 'CHANGE\\t%s\\t%s\\t%s\\n' "$kind" "$2" "$1"
}
git -c core.quotePath=false diff --name-only HEAD -- | while IFS= read -r f; do check "$f" tracked; done
tmp=$(mktemp -d) || exit 5
git -c core.quotePath=false ls-files | sort > "$tmp/head"
git -c core.quotePath=false ls-tree -r --name-only "$T" | sort > "$tmp/target"
comm -13 "$tmp/head" "$tmp/target" | while IFS= read -r f; do check "$f" untracked; done
rm -rf "$tmp"
`;
}

export function parseInspect(stdout: string): ServerChanges | null {
  if (stdout.split("\n").some((l) => l.trim() === "NOREPO")) return null;
  const result: ServerChanges = { head: "", target: "", changes: [] };
  for (const line of stdout.split("\n")) {
    const [tag, ...rest] = line.split("\t");
    if (tag === "HEAD") result.head = rest[0] ?? "";
    else if (tag === "TARGET") result.target = rest[0] ?? "";
    else if (tag === "CHANGE" && rest.length >= 3) {
      const [kind, tracked, ...pathParts] = rest;
      result.changes.push({
        kind: kind as ChangeKind,
        tracked: tracked === "tracked",
        path: pathParts.join("\t"),
      });
    }
  }
  return result;
}

export async function inspectServerChanges(
  target: SSHTarget,
  location: RepoLocation,
): Promise<ServerChanges | null> {
  const { stdout } = await sshExec(
    target,
    `${gitSshEnv(location.repo, location.service)}sh -s`,
    { input: inspectScript(location.deployPath, location.branch) },
  );
  return parseInspect(stdout);
}

/** Changes the deploy would lose: everything but `same`. */
export function conflicting(changes: ServerChange[]): ServerChange[] {
  return changes.filter((c) => c.kind !== "same");
}

/** Copies `paths` into .git/nodeploy-backups/<time>/ — inside .git, where
 * neither `git reset` nor `git clean` reaches. SQLite databases go through
 * sqlite3's online backup when it's installed, since a plain copy of a
 * database being written can be torn. Prints `BACKUP <dir>`. */
export function backupScript(deployPath: string, paths: string[]): string {
  return `set -eu
cd "${deployPath}"
dir=".git/nodeploy-backups/$(date +%Y-%m-%d_%H-%M-%S)"
mkdir -p "$dir"
backup() {
  mkdir -p "$dir/$(dirname -- "$1")"
  if [ "$(head -c 15 -- "$1" 2>/dev/null)" = "SQLite format 3" ] && command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$1" ".backup '$dir/$1'"
  else
    cp -p -- "$1" "$dir/$1"
  fi
}
${paths.map((p) => `backup ${shellQuote(p)}`).join("\n")}
printf 'BACKUP\\t%s/%s\\n' "$(pwd)" "$dir"
`;
}

export async function backupServerFiles(
  target: SSHTarget,
  deployPath: string,
  paths: string[],
): Promise<string> {
  const { stdout } = await sshExec(target, "sh -s", {
    input: backupScript(deployPath, paths),
  });
  const line = stdout.split("\n").find((l) => l.startsWith("BACKUP\t"));
  return line ? line.slice("BACKUP\t".length) : `${deployPath}/.git/nodeploy-backups`;
}

/** Like ensureRepo's fetch + reset, but the server's copies of `keep`
 * survive it, with no window for data loss. A tracked file the new commit
 * drops is just untracked first (`git rm --cached` leaves the file alone).
 * Any other file is moved aside and back with `mv`, which keeps it the same
 * file (inode) — so an app with it open (a SQLite database, a log) keeps
 * writing to the copy that ends up in place, before and after. A copy-back
 * would instead lose whatever the app writes until it's restarted. */
export function keepSyncScript(
  deployPath: string,
  branch: string,
  keep: ServerChange[],
): string {
  const untrack = keep.filter((c) => c.kind === "deleted" && c.tracked);
  const moveAside = keep.filter((c) => !(c.kind === "deleted" && c.tracked));
  return `set -u
cd "${deployPath}" || exit 1
git fetch origin ${shellQuote(branch)} || exit 1
K=.git/nodeploy-keep
rm -rf "$K" && mkdir -p "$K" || exit 1
${untrack.length > 0 ? `git rm -q --cached -- ${untrack.map((c) => shellQuote(c.path)).join(" ")} || exit 1` : ""}
for f in ${moveAside.map((c) => shellQuote(c.path)).join(" ") || "''"}; do
  [ -n "$f" ] || continue
  mkdir -p "$K/$(dirname -- "$f")" && mv -- "$f" "$K/$f" || exit 1
done
git reset --hard ${shellQuote(`origin/${branch}`)}; rc=$?
for f in ${moveAside.map((c) => shellQuote(c.path)).join(" ") || "''"}; do
  [ -n "$f" ] || continue
  mkdir -p "$(dirname -- "$f")" && mv -f -- "$K/$f" "$f"
done
rm -rf "$K"
exit $rc
`;
}

const KIND_TEXT: Record<ChangeKind, string> = {
  overwritten: "git's version is different — it would be overwritten",
  deleted: "the commit being deployed doesn't have it — it would be deleted",
  same: "already matches the commit being deployed",
};

/** The message `deploy` stops with. */
export function guardMessage(
  service: string,
  changes: ServerChange[],
): string[] {
  const width = Math.min(48, Math.max(...changes.map((c) => c.path.length)));
  return [
    `Deploying ${service} would change ${changes.length} file(s) on the server that differ from git — stopped, nothing was touched:`,
    ...changes.map(
      (c) =>
        `    ${c.path.padEnd(width)}  ${c.tracked ? "changed on the server" : "not tracked on the server"}; ${KIND_TEXT[c.kind]}`,
    ),
    "  Files like these are usually app data written at runtime (a database, a JSON store). Pick one:",
    "    nodeploy deploy --keep-server-files        keep the server's copies, deploy everything else",
    "    nodeploy deploy --overwrite-server-files   use git's versions",
    "    nodeploy pull-files                        copy the server's versions into this repo to commit them to git, then deploy",
    "  Either flag backs the files up on the server first (.git/nodeploy-backups/).",
    "  For data, the lasting fix is to stop tracking it: add it to .gitignore, `git rm --cached <file>`, commit and push, then deploy once with --keep-server-files.",
  ];
}

export async function syncRepoKeeping(
  target: SSHTarget,
  location: RepoLocation,
  keep: ServerChange[],
): Promise<void> {
  // stdin carries the script, so git's output is printed afterwards
  // instead of streamed.
  const { stdout } = await sshExec(
    target,
    `${gitSshEnv(location.repo, location.service)}sh -s 2>&1`,
    { input: keepSyncScript(location.deployPath, location.branch, keep) },
  );
  if (stdout.trim()) console.log(stdout.trimEnd());
}
