import type { TerminalRecord } from "@herta/core";

/** Max speech blocks kept in the recent-dialogue slice. */
const DIALOGUE_MAX_BLOCKS = 8;
/** Max chars of the rendered recent-dialogue content. */
const DIALOGUE_MAX_CHARS = 2000;
/** Max done-markers kept in the working-history slice. */
const HISTORY_MAX_MARKERS = 3;
/** Max chars of the rendered working-history content. */
const HISTORY_MAX_CHARS = 1500;

/**
 * Index of the last terminal marker — the previous dispatch's end — or -1 when
 * this is the session's first dispatch. The marker is a system block carrying
 * role "done-marker" | "noop-marker" (set only by the bridge). The current
 * dispatch hasn't produced a marker yet, so this is always the PRIOR dispatch.
 */
export function findLastDispatchBoundary(record: TerminalRecord): number {
  for (let i = record.length - 1; i >= 0; i -= 1) {
    const b = record[i];
    if (
      b?.kind === "system" &&
      (b.role === "done-marker" || b.role === "noop-marker")
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * The interleaved user + Herta-speech exchange AFTER the boundary — the
 * conversation that shaped the current dispatch (so the backend can resolve an
 * elliptical "好"/"就这个" against the proposal it confirmed). Herta thoughts
 * and system blocks are excluded. Bounded to the last DIALOGUE_MAX_BLOCKS /
 * DIALOGUE_MAX_CHARS. Returns "" when there is nothing to show.
 */
export function extractRecentDialogue(
  record: TerminalRecord,
  boundary: number,
): string {
  const lines: string[] = [];
  for (let i = boundary + 1; i < record.length; i += 1) {
    const b = record[i];
    if (b === undefined) continue;
    if (b.kind === "user") lines.push(`开拓者：${b.text}`);
    else if (b.kind === "herta" && b.surface === "speech")
      lines.push(`黑塔：${b.text}`);
  }
  return boundContent(lines, DIALOGUE_MAX_BLOCKS, DIALOGUE_MAX_CHARS);
}

/**
 * The outcomes of earlier dispatches this session — the done-marker blocks AT
 * OR BEFORE the boundary (so the previous dispatch's result is included). Noop-
 * markers contribute nothing. Each entry is the marker body plus its
 * evidenceDetail (changed files / risks). Bounded to the last
 * HISTORY_MAX_MARKERS / HISTORY_MAX_CHARS. Returns "" when there is none.
 */
export function extractWorkingHistory(
  record: TerminalRecord,
  boundary: number,
): string {
  const end = boundary < 0 ? record.length : boundary + 1;
  const entries: string[] = [];
  for (let i = 0; i < end; i += 1) {
    const b = record[i];
    if (b?.kind === "system" && b.role === "done-marker") {
      entries.push(
        b.evidenceDetail !== undefined && b.evidenceDetail.length > 0
          ? `${b.body}\n${b.evidenceDetail}`
          : b.body,
      );
    }
  }
  return boundContent(entries, HISTORY_MAX_MARKERS, HISTORY_MAX_CHARS);
}

/**
 * Keep the last `maxItems` items, join with blank lines, then drop from the
 * FRONT until under `maxChars` (always keep at least one). "" when empty.
 */
function boundContent(
  items: readonly string[],
  maxItems: number,
  maxChars: number,
): string {
  let kept = items.slice(-maxItems);
  let out = kept.join("\n\n");
  while (out.length > maxChars && kept.length > 1) {
    kept = kept.slice(1);
    out = kept.join("\n\n");
  }
  return out;
}
