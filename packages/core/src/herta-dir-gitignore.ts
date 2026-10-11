import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Keep `<workspaceRoot>/.herta` out of the user's git history (audit BL6).
 *
 * When Herta runs against a real repository — which is the whole point — she
 * writes transcripts, command logs, persisted tool results and permission
 * grants into a `.herta` directory beside the user's source. Nothing wrote a
 * `.gitignore`, so the first `git add -A` after a session swept all of it into
 * a commit: session transcripts (the user's own words), command output, and
 * a permissions file describing what they allowed.
 *
 * Self-ignoring (`*` covers the .gitignore too) so the file itself does not
 * show up as an untracked change the moment it is created. A user who WANTS
 * to track something under `.herta` can delete or edit it; this only ever
 * writes when nothing is there.
 *
 * Best-effort by construction: a read-only workspace, a race with another
 * process, any IO error — none of them should fail the operation that
 * happened to be the first to create the directory.
 */
export function ensureHertaGitignore(workspaceRoot: string): void {
  try {
    const dir = join(workspaceRoot, ".herta");
    const file = join(dir, ".gitignore");
    if (existsSync(file)) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      "# Herta's working directory — transcripts, logs, tool results,\n" +
        "# permission grants. Not source; not meant for version control.\n" +
        "# Delete this file if you want to track something in here.\n" +
        "*\n",
      "utf8",
    );
  } catch {
    /* best-effort — never fail a session over a convenience file */
  }
}
