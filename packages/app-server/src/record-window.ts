import type { TerminalRecord } from "@herta/core";

/**
 * How many trailing blocks a full-record payload to the renderer carries
 * (the reset snapshot on open, the record-channel reset on rewind/heal).
 * The renderer WINDOWS long sessions (2026-07-12): it receives this tail,
 * renders it, and pages older blocks on demand over `session:recordSlice` —
 * a 10MB session no longer crosses IPC in one message or mounts thousands
 * of DOM rows. Main always keeps the full record (the actor's prompt,
 * rewind, and the persist cursor all need it); this is a VIEW bound only.
 */
export const RECORD_TAIL_BLOCKS = 200;

export interface RecordTail {
  /** The trailing window. */
  readonly record: TerminalRecord;
  /** Absolute index of `record[0]` in the full record — the count of OLDER
   *  blocks not included (0 = the window is the whole record). */
  readonly start: number;
}

/** The trailing `max` blocks of `record` plus the absolute index the window
 *  starts at. A record within the bound returns whole with start 0. */
export function recordTail(
  record: TerminalRecord,
  max: number = RECORD_TAIL_BLOCKS,
): RecordTail {
  if (record.length <= max) return { record, start: 0 };
  return {
    record: record.slice(record.length - max),
    start: record.length - max,
  };
}
