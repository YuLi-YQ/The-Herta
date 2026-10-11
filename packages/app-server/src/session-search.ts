import { open } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { TerminalRecordBlock } from "@herta/core";
import type { SessionMetadata } from "./types.js";

/** One content match: the session plus a short window of the first matching
 *  dialogue block, for the sidebar card's preview line. */
export interface SessionSearchHit {
  readonly sessionId: string;
  readonly snippet: string;
  /**
   * ABSOLUTE record index to jump to when the card is clicked (2026-07-27) —
   * without it, opening a searched session landed at the LATEST turn and the
   * reader had to hunt for what they searched for.
   *
   * A match on HERTA speech resolves to the user block that opened the
   * exchange, not to the reply itself: the renderer only stamps
   * `data-abs-index` on user rows (the topic rail's jump relies on the same
   * anchor), and landing on the question with the answer below it reads
   * better than landing mid-answer. A match with no preceding user block
   * (a session opening) resolves to itself.
   */
  readonly blockIndex: number;
}

/** Meta lines (`session_meta` / `workspace_set` / `turn_end`) carry `_kind`
 *  and are NOT record blocks — `readSessionFile` skips them when building the
 *  record, so the block index must skip them too. */
const META_MARK = '"_kind":';
/** A user block. Blocks are persisted as `JSON.stringify({kind, text, …})`. */
const USER_MARK = '"kind":"user"';

/** Code points of lead-in context kept before the match in a snippet. */
const SNIPPET_BEFORE = 12;
/** Total snippet length in code points. */
const SNIPPET_LEN = 60;
/** Cap on returned hits — the sidebar shows a filtered list, not a result
 *  page, so a bounded scan is plenty and keeps the IPC payload small. */
export const DEFAULT_HIT_LIMIT = 50;

/**
 * A short window of `text` centered near the first case-insensitive match of
 * `query`, or null when it doesn't match. Whitespace runs are collapsed first
 * (block text may span lines; the card preview is single-line). Windowing is
 * code-point based so a CJK/emoji match never slices a surrogate pair.
 * Exported for unit tests.
 */
export function snippetAround(text: string, query: string): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  const idx = flat.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return null;
  const cps = [...flat];
  // Map the UTF-16 match index to a code-point index.
  let cpIdx = 0;
  let u = 0;
  for (const c of cps) {
    if (u >= idx) break;
    u += c.length;
    cpIdx += 1;
  }
  const start = Math.max(0, cpIdx - SNIPPET_BEFORE);
  const slice = cps.slice(start, start + SNIPPET_LEN).join("");
  const leading = start > 0 ? "…" : "";
  const trailing = start + SNIPPET_LEN < cps.length ? "…" : "";
  return `${leading}${slice}${trailing}`;
}

/** Chunk size for the streaming line scan. */
const SCAN_CHUNK_BYTES = 64 * 1024;

/**
 * The 板砖-alias query variant (ADR 0015): an EN user only ever SEES `@Brick`
 * / `Brick`, but the record stores the wire token `板砖` — so a search for
 * "brick" must also match the stored form. Maps, case-insensitively and
 * boundary-safely, `@brick`→`@板砖` first (so the trigger form wins) and then
 * bare `brick`→`板砖`. Returns the query unchanged when nothing maps; the
 * caller matches against EITHER variant when they differ. Exported for unit
 * tests.
 */
export function brickQueryVariant(query: string): string {
  return query
    .replace(/(?<![\w@])@brick\b/gi, "@板砖")
    .replace(/(?<![\w@])brick\b/gi, "板砖");
}

/**
 * The raw-JSONL prefilter needle for `query` (2026-07-12 streaming rework):
 * JSON.stringify escapes per-character and context-free, so whenever a
 * block's text contains `query`, the raw line contains the ESCAPED form of
 * `query` as a substring — testing the raw line for it is a necessary
 * condition for a match, with no false negatives. Lines that fail it are
 * skipped WITHOUT JSON.parse, which is where the old full-parse scan spent
 * nearly all its time. (A prefilter PASS can still be a non-match — e.g. the
 * query occurring in a key or a thought block — the parse+check after it
 * stays authoritative.) Lowercased for the case-insensitive contract.
 */
export function rawPrefilterNeedle(query: string): string {
  return JSON.stringify(query).slice(1, -1).toLowerCase();
}

/** A hit within one transcript: the snippet plus the record index to land on. */
interface ScanHit {
  readonly snippet: string;
  readonly blockIndex: number;
}

/**
 * Running position while scanning one transcript.
 *
 * Both counters are maintained with RAW substring tests rather than a parse,
 * deliberately: the prefilter below exists so that non-matching lines are
 * never `JSON.parse`d (that was the whole 2026-07-12 speedup), and parsing
 * every line just to count blocks would hand it straight back. The tests are
 * exact for harness-written lines — the persister emits `_kind` first on meta
 * lines and `kind` first on blocks — and the cost of a miss is a jump landing
 * one turn off, never a wrong or corrupt result. A message whose text
 * literally contains `"_kind":` is the only way to skew it.
 */
interface ScanPos {
  /** Record index the NEXT block line will occupy. */
  blockIndex: number;
  /** Index of the most recent user block, or -1 before the first. */
  lastUserIndex: number;
}

/** Advance `pos` past one raw line, returning the index that line occupies
 *  (or -1 when it is a meta line and occupies none). */
function advance(pos: ScanPos, line: string): number {
  if (line === "" || line.includes(META_MARK)) return -1;
  const idx = pos.blockIndex;
  pos.blockIndex += 1;
  if (line.includes(USER_MARK)) pos.lastUserIndex = idx;
  return idx;
}

/** First matching dialogue snippet in one transcript, or null. Streams the
 *  file in chunks, splitting lines across boundaries; stops (and closes the
 *  handle) at the first hit. A block matches when it matches ANY of `queries`
 *  (the raw query and, when it differs, its brick→板砖 variant). Throws on
 *  I/O errors — the caller skips the file.
 *
 *  Async reads (2026-09-03): each 64 KB chunk is read off the event loop and
 *  scanned in well under a millisecond (measured ~105 MB/s), so a large
 *  corpus no longer holds the Electron main thread for the whole scan — a
 *  50 MB transcript set used to block it for ~0.5 s per debounced keystroke;
 *  now every IPC in between gets its turn between chunks. */
async function scanTranscript(
  path: string,
  queries: readonly string[],
): Promise<ScanHit | null> {
  const needles = queries.map(rawPrefilterNeedle);
  const fh = await open(path, "r");
  const pos: ScanPos = { blockIndex: 0, lastUserIndex: -1 };
  const hitAt = (line: string): ScanHit | null => {
    const idx = advance(pos, line);
    if (idx < 0) return null;
    const snippet = matchLine(line, needles, queries);
    if (snippet === null) return null;
    // Herta speech resolves to the user block that opened the exchange (see
    // SessionSearchHit.blockIndex).
    if (line.includes(USER_MARK)) return { snippet, blockIndex: idx };
    if (pos.lastUserIndex >= 0) {
      return { snippet, blockIndex: pos.lastUserIndex };
    }
    // Herta speech with NO preceding user block used to anchor to itself
    // (audit BL13) — and the only block that can be there is the canned
    // opening at record index 0. `data-abs-index` is stamped on USER rows
    // only, so that anchor row never materializes: jumpToTopic unpins,
    // waits for a row that cannot appear, and leaves the reader adrift with
    // no fallback. Dropping the hit is the honest fix; the opening is a
    // fixed greeting, not something anyone searches for on purpose.
    return null;
  };
  try {
    const buf = Buffer.alloc(SCAN_CHUNK_BYTES);
    // StringDecoder, not buf.toString: a chunk boundary can split a
    // multi-byte UTF-8 sequence (any CJK char), and toString would emit
    // replacement chars — garbling the very line being carried over. The
    // decoder buffers the incomplete sequence into the next write.
    const decoder = new StringDecoder("utf8");
    let carry = "";
    for (;;) {
      const { bytesRead: n } = await fh.read(buf, 0, buf.length, null);
      if (n <= 0) break;
      const lines = (carry + decoder.write(buf.subarray(0, n))).split("\n");
      // The last piece may be a partial line — carry it into the next chunk.
      carry = lines.pop() ?? "";
      for (const line of lines) {
        const hit = hitAt(line);
        if (hit !== null) return hit;
      }
    }
    // The final (unterminated) line — a truncated interrupted write parses
    // as corrupt and is skipped by matchLine like any other bad line.
    return hitAt(carry + decoder.end());
  } finally {
    await fh.close();
  }
}

/**
 * What one completed search leaves behind for the next keystroke
 * (2026-09-03) — see {@link narrowSearchCandidates}.
 */
export interface SearchMemo {
  /** The query as searched (trimmed). */
  readonly query: string;
  readonly hitSessionIds: readonly string[];
  /** True when the hit cap was NOT reached, so `hitSessionIds` is the
   *  COMPLETE set of sessions matching `query` among `candidateCount`. */
  readonly exhaustive: boolean;
  /** How many sessions the listing had — the memo is only about that set. */
  readonly candidateCount: number;
  /** When it completed (ms epoch); a memo older than `maxAgeMs` is dropped. */
  readonly at: number;
}

/** A memo older than this is ignored: an open session keeps growing while
 *  the user types, and a session that did not match a minute ago may now. */
export const SEARCH_MEMO_MAX_AGE_MS = 60_000;

/**
 * The sessions worth scanning for `query`, given what the previous search
 * found (2026-09-03). Typing "parser" one letter at a time used to scan every
 * transcript on disk on each debounced keystroke; but a query that CONTAINS
 * the previous one can only match a subset of the sessions the previous one
 * matched — so when the previous scan was exhaustive (under the hit cap) over
 * the same listing, only its hits need reading. Full scan otherwise, and in
 * every case the memo cannot vouch for:
 * - the listing changed size (a session created or deleted since);
 * - the memo is stale (see SEARCH_MEMO_MAX_AGE_MS);
 * - the 板砖 alias (ADR 0015) enters or changes: "bric" → "brick" starts
 *   matching the stored 板砖 token, which no literal-"bric" session need
 *   carry, so the containment argument only holds when the MAPPED forms
 *   contain each other too.
 * `alwaysInclude` (the open session) is scanned regardless — it is the one
 * transcript that grows under the user's hands.
 */
export function narrowSearchCandidates(
  memo: SearchMemo | null,
  query: string,
  sessions: readonly SessionMetadata[],
  opts: { readonly alwaysInclude?: string; readonly now?: number } = {},
): readonly SessionMetadata[] {
  if (memo === null || !memo.exhaustive) return sessions;
  const now = opts.now ?? Date.now();
  if (now - memo.at > SEARCH_MEMO_MAX_AGE_MS) return sessions;
  if (memo.candidateCount !== sessions.length) return sessions;
  const q = query.trim().toLowerCase();
  const prev = memo.query.toLowerCase();
  if (prev === "" || !q.includes(prev)) return sessions;
  if (
    !brickQueryVariant(q)
      .toLowerCase()
      .includes(brickQueryVariant(prev).toLowerCase())
  ) {
    return sessions;
  }
  const keep = new Set(memo.hitSessionIds);
  if (opts.alwaysInclude !== undefined) keep.add(opts.alwaysInclude);
  return sessions.filter((s) => keep.has(s.sessionId));
}

/** Prefilter → parse → dialogue check for one raw JSONL line. The snippet
 *  windows around whichever query variant actually matched the block text. */
function matchLine(
  line: string,
  needles: readonly string[],
  queries: readonly string[],
): string | null {
  if (line === "") return null;
  const lower = line.toLowerCase();
  if (!needles.some((needle) => lower.includes(needle))) return null;
  let parsed: TerminalRecordBlock;
  try {
    parsed = JSON.parse(line) as TerminalRecordBlock;
  } catch {
    return null; // corrupt line — skip it, keep scanning the rest
  }
  const text =
    parsed.kind === "user"
      ? parsed.text
      : parsed.kind === "herta" && parsed.surface === "speech"
        ? parsed.text
        : null;
  if (typeof text !== "string") return null;
  for (const query of queries) {
    const snippet = snippetAround(text, query);
    if (snippet !== null) return snippet;
  }
  return null;
}

/**
 * Content search over persisted session transcripts: case-insensitive
 * substring match against the DIALOGUE — user blocks and Herta speech blocks
 * — of each listed session, first match wins per session. A query containing
 * the EN display alias ("brick"/"@brick") also matches the stored wire token
 * (see brickQueryVariant). Thought blocks,
 * system/backend blocks, and meta lines are deliberately excluded: the
 * sidebar search recalls conversations by what was SAID, and a hit on text
 * the card can't show would read as a false positive.
 *
 * Streaming (2026-07-12): each file is scanned line-by-line in 64KB chunks
 * with a raw-line prefilter (see rawPrefilterNeedle) — non-matching lines
 * are never JSON.parsed, and the scan stops at the first hit. This replaced
 * readSessionFile, which parsed EVERY line of EVERY transcript per query.
 * Corruption tolerance improved with it: a bad line skips that line, not
 * the whole file.
 *
 * Best-effort per file: an unreadable transcript is skipped, never thrown
 * (mirrors listSessions' tolerance). Sessions are scanned in the
 * caller-given order (newest-first from listSessions), capped at `limit`
 * hits.
 */
export async function searchSessionTranscripts(opts: {
  readonly transcriptDir: string;
  readonly sessions: readonly SessionMetadata[];
  readonly query: string;
  readonly limit?: number;
}): Promise<SessionSearchHit[]> {
  const query = opts.query.trim();
  if (query === "") return [];
  // An EN user searches the alias they see ("brick"/"@brick"); the record
  // holds the wire token. When the mapped variant differs, a block matches
  // EITHER form (see brickQueryVariant).
  const mapped = brickQueryVariant(query);
  const queries = mapped === query ? [query] : [query, mapped];
  const limit = opts.limit ?? DEFAULT_HIT_LIMIT;
  const hits: SessionSearchHit[] = [];
  for (const meta of opts.sessions) {
    if (hits.length >= limit) break;
    try {
      const hit = await scanTranscript(
        join(opts.transcriptDir, `${meta.sessionId}.jsonl`),
        queries,
      );
      if (hit !== null) {
        hits.push({
          sessionId: meta.sessionId,
          snippet: hit.snippet,
          blockIndex: hit.blockIndex,
        });
      }
    } catch {
      // Unreadable transcript — skip it, like the material scan does.
    }
  }
  return hits;
}
