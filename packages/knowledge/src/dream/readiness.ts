import type { TerminalRecord } from "@herta/core";

/** Count 黑塔 turns — speech or thought blocks — in a session record. This is
 *  the voice-density proxy the material gate uses to judge a single session as
 *  "long enough" to distill on its own (user/系统/差分协处理器 blocks don't count).
 *
 *  With `sinceMs`, only blocks stamped AFTER it count — the material that is
 *  new since the last completed pass. Counting the whole record let a
 *  weeks-old session touched by a single block re-qualify for a full pass
 *  every cooldown (dream review 2026-09-22, finding 11). A block with no
 *  parseable stamp predates stamping and is old by definition. */
export function countHertaTurns(record: TerminalRecord, sinceMs = 0): number {
  let n = 0;
  for (const block of record) {
    if (block.kind !== "herta") continue;
    if (sinceMs > 0) {
      const at = block.at === undefined ? Number.NaN : Date.parse(block.at);
      if (!(at > sinceMs)) continue;
    }
    n++;
  }
  return n;
}

/**
 * True when a session's last-activity timestamp is strictly after the anchor —
 * i.e. the session was modified since the last completed pass. Unparseable
 * timestamps are treated as NOT modified (excluded). `sinceMs` is the ms-epoch
 * of the last completed pass; pass 0 when no pass has ever completed, so every
 * parseable session counts as new.
 */
export function isModifiedSince(
  lastActivityAt: string,
  sinceMs: number,
): boolean {
  const at = Date.parse(lastActivityAt);
  return !Number.isNaN(at) && at > sinceMs;
}

export interface MaterialThresholds {
  /** Fire if at least this many sessions are new since the last completed pass. */
  readonly minNewSessions: number;
  /** ...or if any single new session has at least this many 黑塔 turns. */
  readonly minSessionHertaTurns: number;
}

/**
 * Decide whether enough new material has accumulated to justify a Dream pass.
 *
 * `newSessionRecords` is the set of session records modified since the last
 * completed pass. Returns true when there are enough new sessions OR one of
 * them has enough 黑塔 turns SINCE the last pass (`sinceMs`) to stand on its
 * own. The cadence floor (cooldown) is enforced separately by the trigger —
 * this is only the "is there anything worth distilling" half of the gate.
 */
export function hasEnoughMaterial(
  newSessionRecords: readonly TerminalRecord[],
  thresholds: MaterialThresholds,
  sinceMs = 0,
): boolean {
  if (newSessionRecords.length >= thresholds.minNewSessions) return true;
  for (const record of newSessionRecords) {
    if (countHertaTurns(record, sinceMs) >= thresholds.minSessionHertaTurns) {
      return true;
    }
  }
  return false;
}
