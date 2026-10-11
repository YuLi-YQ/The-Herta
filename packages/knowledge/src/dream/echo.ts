/**
 * Retrieval-echo reinforcement (ADR 0023 — the §7 "use strengthens" gap in
 * docs/what-is-memory.md).
 *
 * Her whole live 废案 corpus rides in every prompt, so there is no retrieval
 * step to observe — but there IS an observable echo: when a live session shows
 * her REUSING a memory's move (a distinctive contiguous run from its
 * （我 说）/（我 想） lines re-appearing in her live speech or thought), that
 * memory demonstrably served as few-shot material. Bjork's retrieval-strength
 * account says exactly this should restrengthen the trace.
 *
 * Fully DETERMINISTIC — no LLM, no embeddings: whitespace-stripped substring
 * matching at a fixed window length. The corpus is small (≤ ~24 live records),
 * so the sweep is O(small) per episode.
 */
import { readTextFile } from "./pass-ops.js";
import type { DreamCreatedRecord, Episode } from "./types.js";

/** Any dialogue fence marker line: opener or closer, any role. Matched against
 *  a TRIMMED line — the corpus grammar puts fences on their own lines. */
const FENCE_LINE = /^（(\/?)([^（）/\s]+)\s+(?:说|想)）$/;

/** Strip ALL whitespace so line-wrapping (and incidental spacing) can never
 *  break a match — the live renderer wraps speech freely. */
function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

/** The episode's herta-authored text (both speech and thought surfaces),
 *  concatenated and whitespace-stripped. User and system blocks never
 *  contribute — an echo is HER reuse, not the user quoting her. */
function episodeHertaText(episode: Episode): string {
  let out = "";
  for (const b of episode.blocks) {
    if (b.kind === "herta") out += b.text;
  }
  return stripWhitespace(out);
}

/**
 * The content lines inside a 废案 body's （我 说）…（/我 说） and
 * （我 想）…（/我 想） fences. Small tolerant parser:
 * - an opener line of another role (（开拓者 说） etc.) closes any open
 *   我-fence (fences never nest in the grammar);
 * - any closer line closes;
 * - an unclosed 我-fence is tolerated — EOF closes it, content kept.
 */
export function extractHertaFenceLines(body: string): string[] {
  const lines: string[] = [];
  let inHertaFence = false;
  for (const raw of body.split(/\r?\n/)) {
    const trimmed = raw.trim();
    const fence = FENCE_LINE.exec(trimmed);
    if (fence !== null) {
      const isCloser = fence[1] === "/";
      inHertaFence = !isCloser && fence[2] === "我";
      continue;
    }
    if (inHertaFence && trimmed.length > 0) lines.push(raw);
  }
  return lines;
}

/** True when any contiguous `minChars`-long substring of a record line (both
 *  sides whitespace-stripped) appears in the episode text. Early exit on the
 *  first hit. */
function lineEchoes(
  episodeText: string,
  recordLine: string,
  minChars: number,
): boolean {
  const stripped = stripWhitespace(recordLine);
  if (stripped.length < minChars) return false;
  for (let i = 0; i + minChars <= stripped.length; i++) {
    if (episodeText.includes(stripped.slice(i, i + minChars))) return true;
  }
  return false;
}

/**
 * The live records this episode ECHOES — reuses a distinctive
 * `minChars`-long run from their （我 说）/（我 想） lines in its own herta
 * text. Deterministic; the caller reinforces each hit (spacing-guarded).
 *
 * SELF-ECHO GUARDS (critical): a 废案 trivially echoes the session it was
 * distilled from — its lines were AUTHORED out of that session's speech. So a
 * record is skipped when it was born from this episode's session
 * (`sourceSessionId`) or when this episode already contributed to it
 * (`sourceEpisodes`).
 *
 * @param episode      The fresh episode under consideration.
 * @param liveRecords  The live dream-created records (seeds have no manifest
 *                     record and never participate).
 * @param narrativeDir Where the live 废案 bodies live (per-language dir).
 * @param minChars     Window length; ≤ 0 disables (returns []). 12 contiguous
 *                     non-whitespace CJK chars is distinctive.
 */
export function findEchoedRecords(
  episode: Episode,
  liveRecords: readonly DreamCreatedRecord[],
  narrativeDir: string,
  minChars: number,
): DreamCreatedRecord[] {
  if (minChars <= 0) return [];
  const episodeText = episodeHertaText(episode);
  if (episodeText.length < minChars) return [];

  const echoed: DreamCreatedRecord[] = [];
  for (const record of liveRecords) {
    if (record.sourceSessionId === episode.sessionId) continue;
    if (record.sourceEpisodes.includes(episode.episodeHash)) continue;
    const body = readTextFile(narrativeDir, record.file);
    if (body === undefined) continue;
    if (
      extractHertaFenceLines(body).some((line) =>
        lineEchoes(episodeText, line, minChars),
      )
    ) {
      echoed.push(record);
    }
  }
  return echoed;
}
