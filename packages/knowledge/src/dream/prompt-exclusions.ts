import type { TerminalRecordBlock } from "@herta/core";
import { liveDreamRecords, segmentationV2SinceMs } from "./manifest.js";
import { segmentSession } from "./segment-session.js";
import type { DreamConfig, DreamManifest } from "./types.js";

/**
 * Reopen own-dream filter (design 2026-07-07).
 *
 * When a session is reopened after a Dream pass has distilled some of its
 * episodes into 废案, the static prefix would otherwise carry a "past memory"
 * of events that still sit verbatim in the reopened record below it — Herta
 * remembering the ongoing conversation as if from another life. This module
 * decides which dreamed 废案 to withhold from ONE session-open's prefix:
 *
 * - Source episode still verbatim in the prompt window (at/after the recap
 *   boundary, or no recap engaged at all) → EXCLUDE: pure duplication.
 * - Source episode behind the recap boundary → INCLUDE: its detail survives
 *   only as a line of the ≤maxRecapChars recap, so the 废案 is recovered
 *   information, not duplication.
 * - Source episodes from other sessions → INCLUDE (hashes never match this
 *   record's segmentation, so this falls out of the matching rule).
 *
 * Matching is by episode content hash against a deterministic re-segmentation
 * of the current record: appending blocks only ever creates NEW episodes
 * (a dreamable episode is always closed by a ≥episodeGapMs gap, because the
 * Dream trigger requires an idle window longer than that gap), so hashes of
 * previously dreamed episodes are stable across the record's growth.
 *
 * The exclusion is per-prompt only — the 废案 file, its manifest entry, and
 * its retention/reactivation bookkeeping are untouched; other sessions and
 * later opens see it normally.
 */
export interface PromptExclusionInputs {
  readonly manifest: DreamManifest;
  readonly sessionId: string;
  /** The record the session is (re)opening with, as loaded from disk. */
  readonly record: readonly TerminalRecordBlock[];
  /** Sticky compaction boundary for this session: blocks BEFORE this index
   *  reach the prompt only via the recap; blocks at/after it are verbatim.
   *  0 = no recap engaged (the whole record is verbatim). The caller is
   *  responsible for validating a cached boundary the same way the recap
   *  runtime does before passing it in. */
  readonly recapBoundaryIndex: number;
  readonly config: Pick<
    DreamConfig,
    "episodeGapMs" | "maxEpisodeBlocks" | "maxEpisodeMs"
  >;
}

/**
 * Filenames (relative to `.herta/narrative/`) of live dreamed 废案 whose
 * source content is still verbatim in this session-open's prompt window.
 * Empty set when there is nothing to withhold.
 */
export function selectPromptExclusions(
  inputs: PromptExclusionInputs,
): ReadonlySet<string> {
  const { manifest, sessionId, record, recapBoundaryIndex, config } = inputs;
  const excluded = new Set<string>();
  const live = liveDreamRecords(manifest);
  if (live.length === 0 || record.length === 0) return excluded;

  // hash → end index of the episode in the current record. Built once per
  // open; segmentation is pure and linear in the record length. Cut the
  // way the ledger was cut (ADR 0069 §4, §7): segmentation v2 from the
  // manifest's cutover, the old rules before it.
  const episodeEnd = new Map<string, number>();
  const v2Cutover = segmentationV2SinceMs(manifest);
  for (const ep of segmentSession(sessionId, record, {
    ...config,
    ...(v2Cutover !== undefined ? { segmentationV2SinceMs: v2Cutover } : {}),
  })) {
    episodeEnd.set(ep.episodeHash, ep.endIndex);
  }
  // hash → the sessions the ledger dreamed it from.
  const ledgerSessions = new Map<string, Set<string>>();
  for (const e of manifest.episodes) {
    const set = ledgerSessions.get(e.episodeHash) ?? new Set<string>();
    set.add(e.sessionId);
    ledgerSessions.set(e.episodeHash, set);
  }

  for (const rec of live) {
    // Withhold only when EVERY source episode is this session's own and
    // either still verbatim in this window or WITHDRAWN from the record —
    // then the record adds nothing the prompt should show. A reconsolidated
    // record that also accretes episodes from other sessions (or from
    // behind the recap boundary) stays in: it carries genuine past the
    // record can't, and losing that costs more than partial overlap.
    //
    // Withdrawn = the session's own source hash is absent from its record.
    // Growth only ever appends new episodes, so an own episode can only
    // vanish when its bytes changed: a rewind truncated it, a take-back
    // rewrote an attachment's body. This used to fail OPEN — the 废案 of
    // the evening the user took back loaded into the prompt while the
    // altered episode sat verbatim below it (dream review 2026-09-22,
    // finding 5). It fails CLOSED now for the session's own sources only;
    // another session's hash is absent here by construction.
    const own = (hash: string): boolean =>
      ledgerSessions.get(hash)?.has(sessionId) === true ||
      (rec.sourceSessionId === sessionId && hash === rec.sourceEpisodeHash);
    const withhold = rec.sourceEpisodes.every((hash) => {
      if (!own(hash)) return false;
      const end = episodeEnd.get(hash);
      return end === undefined || end > recapBoundaryIndex;
    });
    if (withhold && rec.sourceEpisodes.length > 0) {
      excluded.add(rec.file);
    }
  }
  return excluded;
}
