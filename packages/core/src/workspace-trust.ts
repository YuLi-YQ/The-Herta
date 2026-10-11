import type { PermissionRequest } from "./types/events.js";

/**
 * Workspace trust (ADR 0064): the per-workspace tier that answers the ask
 * classes whose effects stay inside the workspace WITHOUT a card, once the
 * owner has said so for that workspace (or the workspace is the session's
 * managed sandbox, where nothing of theirs lives).
 *
 * WHY A TIER AND NOT A WIDER ALLOW LIST. ADR 0045 measured what widening
 * the allow tier costs: three red-team rounds found 7, 35 and 41 silent
 * allows, because the allow tier is a name list over a string nobody
 * parses. This tier does not touch it. Every class here still CLASSIFIES
 * exactly as before — the record shows the row, a write shows its diff —
 * and the block tier, the path guards and the outside/credential/network/
 * destructive classes are not in the set, so a trusted workspace changes
 * which cards the user sees, never what the harness can see.
 *
 * WHAT IS IN THE SET — effects confined to the workspace tree:
 *   - file writes by the three editors (their rules resolved the path
 *     inside the workspace before asking);
 *   - `command_ask_write`   redirects / tee / sed -i to workspace files;
 *   - `command_ask_fs`      mkdir / touch / cp / mv / ln on workspace paths;
 *   - `command_ask_delete`  rm / rmdir / unlink of workspace paths
 *                           (the recursive-force shape is destructive);
 *   - `command_ask_vcs`     git that changes the repo but not its history
 *                           (destructive shapes and remote-touching
 *                           subcommands have their own classes);
 *   - `command_ask_interpreter`  an interpreter running a WORKSPACE script
 *                           (inline code and outside scripts are their own
 *                           classes);
 *   - `command_ask_local_exec`   a workspace-local executable (`./bin/x`);
 *   - `command_ask_script`       `npm run <script>` and friends;
 *   - `command_ask_recursive_read`  `grep -r` inside the workspace (the L3
 *                           choice, owner 2026-09-16).
 *
 * WHAT STAYS A CARD, trusted or not: network (installs, non-loopback
 * curl, git push/fetch/pull), destructive shapes, `cd` out of the
 * workspace, reads of credential or outside paths, an unresolvable
 * program name or argument, env assignments, kill, inline interpreter
 * code, and anything the classifier could not name.
 */
export const WORKSPACE_TRUST_CODES: ReadonlySet<string> = new Set([
  "edit_file_ask",
  "write_new_file_ask",
  "str_replace_editor_ask",
  "command_ask_write",
  "command_ask_fs",
  "command_ask_delete",
  "command_ask_vcs",
  "command_ask_interpreter",
  "command_ask_local_exec",
  "command_ask_script",
  "command_ask_recursive_read",
]);

/**
 * True when EVERY class the request carries is in the trust set — a chained
 * line auto-allows only if each of its segments would. A request with no
 * class at all (a hand-built ask, a rule that named none) is not covered:
 * the tier is earned by a classification, never assumed.
 */
export function trustCovers(request: PermissionRequest): boolean {
  if (request.risk !== "workspace_write" && request.risk !== "workspace_read")
    return false;
  const codes =
    request.codes !== undefined && request.codes.length > 0
      ? request.codes
      : request.code !== undefined
        ? [request.code]
        : [];
  if (codes.length === 0) return false;
  return codes.every((c) => WORKSPACE_TRUST_CODES.has(c));
}
