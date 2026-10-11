import { checkFewShot } from "@herta/herta";
import type { ValidateResult } from "./types.js";

/** The narrative paragraph(s) of a 废案 — the text between the line-1 header
 *  and the first `---` separator, trimmed and capped at `maxChars`. Used as a
 *  content summary for the novelty/similarity comparison. */
export function extractNarrativeOpening(text: string, maxChars = 300): string {
  const lines = text.split(/\r?\n/); // tolerate CRLF so no stray \r leaks in
  // drop everything up to and including the first non-blank header line
  let i = 0;
  while (i < lines.length && lines[i]?.trim().length === 0) i++;
  i++; // skip the header line itself
  const out: string[] = [];
  for (; i < lines.length; i++) {
    if (/^\s*---\s*$/.test(lines[i] ?? "")) break;
    out.push(lines[i] ?? "");
  }
  const opening = out.join("\n").trim();
  return opening.length > maxChars ? `${opening.slice(0, maxChars)}…` : opening;
}

const HEADER_RE = /^### 废案(?:_(\d{2,}))?：(.+)$/;
// A floor against an empty shell, not a budget: header + `---` + one
// （我 说） block is ~35 chars, and the smallest seed runs 1 200 zh / 3 700
// EN chars, so no real page is near it in either script. There is no char
// CEILING — the page's only length cap is the prefix load gate's estimated-
// token cap, applied below (ADR 0014 §6, amended 2026-09-23).
const MIN_CHARS = 60;
// English structural markers that must never leak into a 废案 body. Case-
// insensitive and whitespace-tolerant before the colon (2026-07-09): the
// prior `:`-adjacent Titlecase-only form let `verdict:` / `Verdict :` slip
// the gate and land verbatim in the prefix few-shot. The colon may be ASCII
// or full-width (`Verdict：`) — a Chinese-writing model reaching for the
// leaked English word is at least as likely to close it with Chinese
// punctuation (same-day review follow-up). These words are the
// backend-report vocabulary D2/D3 forbid in her voice; a rare English
// "Plan:" in a memory is itself off-voice, so rejecting it (one regenerate)
// is correct. Verified zero matches against the tracked seed corpus.
// Exported: the trailblazer-notes gate (semanticize.ts) applies the same
// check — both texts load verbatim into the same static prefix.
export const LEAK_MARKERS =
  /\b(Verdict|Changed|Evidence|Summary|Risks?|Plan)\s*[:：]/i;
// The episode digest's own notation (`buildEpisodeDigest`, digest.ts): a
// backend row as `〔差分协处理器（已核实）：…〕` / `〔系统（失败）：…〕`, the
// elision line `〔……此处略去 N 条板砖操作记录〕`, and a supervisor veto as
// `〔黑塔的自我更正：…〕`. None of it is record grammar — the record shows a
// backend row as `→ 系统` / `→ 差分协处理器` (allowed, and the seeds use it)
// and a self-correction as a `——…` aside before her line (serialize.ts) —
// so a page that copies these lines would teach the actor a format it never
// sees in its own record. The generation prompt asks for a correction to be
// kept as dialogue and for a body with no structural metadata; a live lab
// page copied the markers verbatim anyway (ADR 0069, lab for §8 and §9).
// Any tag in the parentheses: a model inventing （已完成） is the same leak.
const DIGEST_MARKER =
  /〔(?:(?:差分协处理器|系统)（[^）\n]*）：|……此处略去|黑塔的自我更正：)/;
// Title-only one-off identifiers: 2+ western digits (covers ISO dates too),
// file-ext tokens, drive/abs path fragments. CJK numerals are not matched
// (\d is ASCII). ISO dates are caught by TITLE_DIGITS (digit-run rule).
const TITLE_DIGITS = /\d{2,}/;
const TITLE_EXT = /\.(ts|tsx|js|jsx|py|go|rs|java|json|md|txt|html|css)\b/i;
// Require a multi-segment path so single-slash word titles like "Unix/Windows"
// are not rejected; e.g. /etc/passwd or C:/Users/foo still match.
const TITLE_PATH = /(?:[A-Za-z]:[\\/]|[\\/]\w+[\\/])/;
// Invisible / control codepoints to reject (allow \n=0x0a, \t=0x09, \r=0x0d).
// Hex ranges (NOT a regex with \u escapes) so the source stays plain ASCII.
const BAD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x2028, 0x2029], // line / paragraph separators (only \n\t\r are allowed)
  [0x200b, 0x200d],
  [0x200e, 0x200f], // LRM, RLM (invisible directional marks)
  [0x202a, 0x202e],
  [0x2060, 0x2064], // word joiner + invisible math operators
  [0x2066, 0x2069],
  [0xd800, 0xdfff], // lone surrogates (for..of yields a lone half here; a
  //                   valid surrogate PAIR resolves to an astral codepoint
  //                   > 0xFFFF and is unaffected — emoji/CJK-Ext are fine)
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f], // Unicode Tag block — invisible; a hidden-instruction
  //                     smuggling channel into the prefix (fence-fuzz 2026-07-09)
];
function hasBadCodepoint(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    for (const [lo, hi] of BAD_RANGES) if (c >= lo && c <= hi) return true;
  }
  return false;
}

export function parseFeianHeader(
  line: string,
): { nn?: number; title: string } | null {
  const m = HEADER_RE.exec(line.trim());
  if (m === null) return null;
  const title = (m[2] ?? "").trim();
  if (title.length === 0) return null;
  return m[1] !== undefined
    ? { nn: Number.parseInt(m[1], 10), title }
    : { title };
}

/** Returns the next available index by scanning filenames of the form `### 废案_NN：<title>.txt` and reading `NN` from that prefix. */
export function nextFeianIndex(existingFilenames: string[]): number {
  let max = -1;
  for (const f of existingFilenames) {
    const m = /^### 废案_(\d{2,})：/.exec(f);
    if (m?.[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

/** The NN of a numbered 废案 filename (`### 废案_NN：<title>.txt`); null for
 *  legacy unnumbered files or non-废案 names. */
export function feianFileIndex(name: string): number | null {
  const m = /^### 废案_(\d{2,})：/.exec(name);
  return m?.[1] !== undefined ? Number.parseInt(m[1], 10) : null;
}

/** Count the LIVE 废案 files in a narrative-dir listing — numbered and legacy
 *  unnumbered forms both count (both are loaded into the actor prefix, which
 *  is what the total budget bounds). Archived files were moved out of the dir
 *  so they never appear here. */
export function countFeianFiles(filenames: readonly string[]): number {
  return filenames.filter((f) => f.startsWith("### 废案") && f.endsWith(".txt"))
    .length;
}

/**
 * The seed-example file to evict when the total 废案 cap binds
 * (M-feian-1, 2026-07-05), or undefined when the band is exhausted.
 *
 * Evictable = a file whose NN lies in (protectedMaxNN, evictableMaxNN]
 * AND that is not a live dream-created record (dream files start above
 * the seed band via nextFeianIndex, but the manifest guard keeps this
 * correct even under misconfiguration). Highest NN first, so the band
 * drains 06 → 05 → 04 → 03 deterministically. Everything outside the
 * band — the protected anchors (NN ≤ protectedMaxNN), legacy unnumbered
 * files, and any hand-authored file above the band — is never returned.
 */
export function pickEvictableSeedFile(
  filenames: readonly string[],
  liveDreamFiles: ReadonlySet<string>,
  protectedMaxNN: number,
  evictableMaxNN: number,
): string | undefined {
  let best: { name: string; nn: number } | undefined;
  for (const f of filenames) {
    if (!f.endsWith(".txt")) continue;
    const nn = feianFileIndex(f);
    if (nn === null) continue;
    if (nn <= protectedMaxNN || nn > evictableMaxNN) continue;
    if (liveDreamFiles.has(f)) continue;
    if (best === undefined || nn > best.nn) best = { name: f, nn };
  }
  return best?.name;
}

export function validateFeian(text: string): ValidateResult {
  const errors: string[] = [];

  if (hasBadCodepoint(text)) {
    errors.push("invalid codepoint: invisible/control character in body");
  }
  if (text.length < MIN_CHARS) errors.push(`too short (<${MIN_CHARS} chars)`);

  const lines = text.split("\n");
  const firstNonBlank = lines.find((l) => l.trim().length > 0) ?? "";
  const header = parseFeianHeader(firstNonBlank);
  if (header === null) {
    errors.push("bad header: line 1 must be `### 废案[_NN]：<title>`");
  } else {
    if (TITLE_DIGITS.test(header.title))
      errors.push("title leak: western digit-run / date (one-off log)");
    if (TITLE_EXT.test(header.title))
      errors.push("title leak: file-extension token");
    if (TITLE_PATH.test(header.title)) errors.push("title leak: path fragment");
  }

  if (!/^\s*---\s*$/m.test(text)) errors.push("missing `---` separator");
  if (LEAK_MARKERS.test(text))
    errors.push("leaked English structural marker (Verdict:/Changed:/…)");
  const digestLines = lines.filter((l) => DIGEST_MARKER.test(l));
  if (digestLines.length > 0) {
    const first = (digestLines[0] ?? "").trim();
    errors.push(
      `copied session-digest marker (${digestLines.length} line(s), first: ` +
        `"${first.length > 60 ? `${first.slice(0, 60)}…` : first}") — the ` +
        "〔…〕 lines are the digest's notation, not the record: retell that " +
        "work in the dialogue or narrative (or as a → 系统 / → 差分协处理器 " +
        "row), and a self-correction in her own words",
    );
  }

  const fenceErr = checkFences(text);
  if (fenceErr !== null) errors.push(fenceErr);
  if (!/（我 说）/.test(text)) errors.push("missing a （我 说） block");

  // The page must also pass the gate that loads it into the prefix
  // (`checkFewShot`): one-deep fences, no truncated tail, the estimated-token
  // cap. This validator allowed nested fences, the load gate does not, so a
  // page could be promoted, take a slot, and then be dropped at every load
  // with only a console warning — the failure shape of 2026-08-06 (dream
  // review 2026-09-22, finding 15). Only its verdict is added: the reasons
  // above already cover the rest.
  //
  // The gate's cap is also the page's ONLY length ceiling. This validator
  // had its own at 16 000 chars, which measured the same prefix cost in the
  // wrong unit: the EN corpus runs ~3.5 chars per estimated token, zh 1.4–
  // 2.1, so it rejected the EN 00/02 anchors (27k / 21k chars, 7.6k / 6.5k
  // tokens) while zh pages of that token size passed — the script bias the
  // gate itself shed in ADR 0051 §3 (ADR 0014 §6, amended 2026-09-23).
  const guard = checkFewShot("dream candidate", text);
  if (!guard.ok) errors.push(`fails the prefix load gate: ${guard.reason}`);

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Verify （X 说/想） openers and （/X 说/想） closers nest correctly. */
function checkFences(text: string): string | null {
  const tag = /（(\/?)([^（）/\s]+)\s+(说|想)）/g;
  const stack: string[] = [];
  for (let m = tag.exec(text); m !== null; m = tag.exec(text)) {
    const closing = m[1] === "/";
    const key = `${m[2]} ${m[3]}`;
    if (!closing) {
      stack.push(key);
    } else {
      const top = stack.pop();
      if (top !== key) return `unbalanced dialogue fence near （/${key}）`;
    }
  }
  return stack.length === 0
    ? null
    : `unbalanced dialogue fence: ${stack.join(", ")} not closed`;
}
