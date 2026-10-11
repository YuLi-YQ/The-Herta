import type { RunCommandData } from "@herta/core";

/**
 * Git outcome identity parsed from one successful command result
 * (ADR 0049 §4). A commit is the one operation whose IDENTITY is the
 * outcome — the sha — and the done marker used to drop it in favour of a
 * file count. Re-derived from git's own output shapes, not copied.
 */
export interface GitOutcome {
  /** Short sha from git commit's own `[branch abc1234] …` summary line. */
  readonly commit?: string;
  /** Destination branch from git push's ref-update line (`src -> dst`). */
  readonly pushedRef?: string;
}

/**
 * `[main abc1234] message` / `[main (root-commit) abc1234]` /
 * `[detached HEAD abc1234]` — the sha is the last token before `]`.
 */
const COMMIT_SUMMARY = /^\[[^\]\n]+? ([0-9a-f]{7,40})\]/m;

/**
 * Push ref-update lines land on STDERR: ` abc123..def456  main -> main`,
 * ` + abc123...def456 main -> main` (forced), ` * [new branch] main -> main`,
 * ` * [new tag] v1 -> v1`. The destination (after `->`) is the remote-side
 * name. A fetch/pull prints the same shape, which is why detection also
 * requires the WORD `push` in the command (see below).
 */
const PUSH_REF_UPDATE =
  /^\s*(?:\+?\s*[0-9a-f]+\.{2,3}[0-9a-f]+|\*\s*\[new (?:branch|tag)\])\s+\S+\s+->\s+(\S+)/m;

/**
 * Detect commit/push outcomes in one finished command's data. Deterministic
 * and deliberately conservative:
 *
 * - exit 0 only — a failed command landed nothing (and a pre-commit-hook
 *   failure means the commit did NOT happen; reporting its sha would be the
 *   fabrication class this record has already paid to remove);
 * - the command text must contain the verb (`commit` / `push`) as well as
 *   `git` — the ref-update shape also appears in fetch/pull output, and a
 *   bash script's echo could imitate either line;
 * - matches are anchored to git's own summary-line shapes.
 *
 * Works for both command tools: `run_command` gives the argv directly and
 * `bash` carries its script inside the argv, so joining is enough for the
 * verb check either way.
 */
export function detectGitOutcome(
  data: Pick<RunCommandData, "argv" | "exitCode" | "stdout" | "stderr">,
): GitOutcome {
  if (data.exitCode !== 0) return {};
  const command = data.argv.join(" ");
  if (!/\bgit\b/.test(command)) return {};
  const out: { commit?: string; pushedRef?: string } = {};
  if (/\bcommit\b/.test(command)) {
    const m = COMMIT_SUMMARY.exec(data.stdout);
    if (m?.[1] !== undefined) out.commit = m[1];
  }
  if (/\bpush\b/.test(command)) {
    // git talks to the user on stderr here, but a bash pipeline may fold
    // streams — check stderr first, then stdout.
    const m =
      PUSH_REF_UPDATE.exec(data.stderr) ?? PUSH_REF_UPDATE.exec(data.stdout);
    if (m?.[1] !== undefined) out.pushedRef = m[1];
  }
  return out;
}
