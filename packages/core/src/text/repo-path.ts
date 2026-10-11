/**
 * Git spells every path relative to the repository ROOT; the workspace
 * 板砖's tools and the viewer resolve against can be a SUBFOLDER of that
 * repository (ADR 0058 amendment, 2026-09-07). These helpers rebase git's
 * spelling onto the workspace so one convention reaches both readers.
 *
 * `prefix` is `git rev-parse --show-prefix`: the workspace's path inside
 * the repository with a trailing slash (`packages/gui/`), "" at the root.
 *
 * Shared by the backend frame (@herta/core) and the GUI renderer via the
 * `@herta/core/repo-path` subpath — the renderer bundle must not pull the
 * package root (node built-ins), the same reason `banzhuan-alias` and
 * `marker-summary` are subpaths.
 */

/** A root-relative git path spelled from the workspace: `x.ts` for a file
 *  under it, `../core/x.ts` for one beside it — what `git status` prints
 *  from that cwd, and what a tool resolving against the workspace needs. */
export function workspaceRelativeRepoPath(
  path: string,
  prefix: string,
): string {
  if (prefix.length === 0) return path;
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  const up = prefix.split("/").filter((s) => s.length > 0);
  const down = path.split("/");
  let common = 0;
  while (
    common < up.length &&
    common < down.length &&
    up[common] === down[common]
  ) {
    common += 1;
  }
  const climbs: string[] = [];
  for (let i = common; i < up.length; i += 1) climbs.push("..");
  return [...climbs, ...down.slice(common)].join("/");
}

/** Whether a root-relative git path lies under the workspace — the only
 *  paths the workspace-jailed readers (ADR 0050 §2) can open. */
export function repoPathInsideWorkspace(path: string, prefix: string): boolean {
  return prefix.length === 0 || path.startsWith(prefix);
}
