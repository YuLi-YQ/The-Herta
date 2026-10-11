/**
 * One definition of "this file is not text".
 *
 * Extracted from `show_excerpt` (ADR 0027) so the attachment ingest (ADR 0033)
 * decides it the same way rather than growing a second, subtly different rule.
 * That matters more than the six lines suggest: the tools reject a binary and
 * the ingest reports one, so if the two disagreed a file could be accepted at
 * the door and then refused by every tool that tried to read it — the user
 * would see an attachment in the record that Herta could never open.
 *
 * A NUL byte in the first 4KB. Crude, and deliberately so: it is the same
 * heuristic git uses, it never false-positives on UTF-8 text (NUL is not a
 * legal UTF-8 continuation byte), and the cost of a false negative is a
 * garbled excerpt.
 *
 * What it is NOT is a guarantee that the bytes are UTF-8 — a GBK / Big5 /
 * Shift-JIS source file sails through it. See `decodeUtf8` below for why that
 * distinction turned out to be load-bearing.
 */
export const SNIFF_BYTES = 4096;

export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, Math.min(SNIFF_BYTES, buf.length)).includes(0);
}

/**
 * Decode file bytes as UTF-8, and say whether that was FAITHFUL.
 *
 * `buf.toString("utf-8")` never fails: every byte it cannot interpret becomes
 * U+FFFD. For a reader that only ever costs a garbled excerpt. For an editor
 * it is data loss, because the write-back path re-encodes the decoded STRING
 * over the whole file — so a hunk touching one ASCII line in a GBK-encoded
 * source silently replaced every Chinese byte in the file, including regions
 * the patch never went near, with replacement characters. Unrecoverable, in
 * the user's own repository, and invisible until someone opened the file
 * (codex study 2026-08-24; reproduced before this guard was written).
 *
 * `lossy` is exact rather than heuristic: a strict decoder either accepts the
 * bytes or it does not. Callers that only READ may use the text and say so;
 * callers that WRITE must refuse.
 */
export function decodeUtf8(buf: Buffer): {
  text: string;
  lossy: boolean;
  bom: boolean;
} {
  const bom = hasUtf8Bom(buf);
  try {
    return {
      // `fatal` aside, a TextDecoder also CONSUMES a leading BOM — which is
      // why `bom` is reported separately. Readers want it gone; writers must
      // put it back.
      text: new TextDecoder("utf-8", { fatal: true }).decode(buf),
      lossy: false,
      bom,
    };
  } catch {
    return {
      text: buf.toString("utf-8").replace(/^\uFEFF/, ""),
      lossy: true,
      bom,
    };
  }
}

/**
 * A leading UTF-8 BOM (`EF BB BF`).
 *
 * It is valid UTF-8, so `decodeUtf8` accepts the file and reports `lossy:
 * false` — and then the decoder silently eats those three bytes. Every editor
 * here rewrites the whole file from the decoded string, so an edit to one
 * ASCII line USED to drop the BOM: bytes the patch never touched, changed.
 * That is the same property ADR 0045 §2 exists to hold, and it matters most on
 * Windows, where a BOM is load-bearing — a PowerShell 5.1 script containing
 * non-ASCII is read as ANSI without one, so removing it corrupts every
 * non-ASCII string in the file at the next run.
 *
 * `looksBinary` is unaffected: a BOM contains no NUL.
 */
export function hasUtf8Bom(buf: Buffer): boolean {
  return (
    buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  );
}

/**
 * Re-attach what `decodeUtf8` stripped, so a write preserves the file's own
 * byte-level shape.
 *
 * Spelled `\uFEFF` rather than as the character itself: a literal BOM in the
 * source is invisible to a reader, and the tools most likely to touch this
 * file are the ones that strip BOMs.
 */
export function reattachBom(text: string, bom: boolean): string {
  return bom && !text.startsWith("\uFEFF") ? `\uFEFF${text}` : text;
}
