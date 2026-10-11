/**
 * Line-aligned chunks of a highlight.js answer (ADR 0068 §13, 2026-09-22).
 *
 * Measured in the built app on a source at the viewer's cap (299K chars,
 * 7 568 lines → 1.37 MB of HTML, 29 281 spans): DOMPurify's pass 437 ms,
 * then 525 ms of layout and a first frame near a second — one `<pre>` whose
 * whole content is a single inline formatting context, laid out at once. And
 * appending pieces to that one block re-lays out everything before them, so
 * a naive slice cost more in total (2.9 s) with 200 ms pieces.
 *
 * The remedy is structural: the text is rendered as BLOCKS of `LINES_PER_CHUNK`
 * lines, each its own formatting context under `content-visibility: auto`
 * with its exact intrinsic height, so layout and paint touch only the chunks
 * on screen; and the highlighted HTML is cut at the SAME line boundaries, so
 * a chunk's plain text can be swapped for its tokens one chunk at a time, a
 * frame's budget per turn, with no line moving. This module is the cutting.
 *
 * highlight.js core emits exactly two kinds of tag — `<span class="…">` and
 * `</span>` — and escapes every `<` in the source, so the HTML is a flat
 * string of text and nested spans. A span may cross a line boundary (a block
 * comment, a template string), so a cut inside one closes the open spans at
 * the end of the piece and reopens the same tags at the start of the next:
 * every piece is balanced on its own and sanitizes on its own. Anything that
 * is not one of those two tags means the answer is not what this expects,
 * and the caller falls back to adopting it whole.
 */

/** Lines per chunk. 200 lines is ~8 KB of source and ~40 KB of tokens —
 *  about 12 ms of DOMPurify per chunk in the app, so several fit in a frame
 *  for an ordinary file and a cap-size file colours in over ~40 frames. */
export const LINES_PER_CHUNK = 200;

export interface HighlightChunk {
  /** Balanced HTML for the chunk's lines, WITHOUT a trailing newline: the
   *  chunk is a block, and the block boundary is the line break. */
  readonly html: string;
  /** The number of lines the chunk covers (its last line included). */
  readonly lines: number;
}

/** A class-only opening span, matched in place (sticky) so no substring is
 *  cut per tag — a cap-size answer holds ~30 000 of them. */
const OPEN_SPAN = /<span class="[^"<>]*">/y;

/**
 * Cut `html` into chunks of `linesPerChunk` lines each (the last one
 * shorter), balanced, aligned to the same boundaries as
 * `chunkLines(text, linesPerChunk)` on the source text. Returns null when the
 * HTML holds a tag other than a class-only `<span>` or `</span>` — not
 * highlight.js's shape, so not something to cut.
 */
export function splitHighlightHtml(
  html: string,
  linesPerChunk: number = LINES_PER_CHUNK,
): HighlightChunk[] | null {
  const chunks: HighlightChunk[] = [];
  const open: string[] = [];
  let piece = "";
  let start = 0;
  let lineInChunk = 0;
  let i = 0;
  const flush = (end: number, lines: number): void => {
    piece += html.slice(start, end);
    chunks.push({ html: piece + "</span>".repeat(open.length), lines });
    piece = open.join("");
  };
  while (i < html.length) {
    const c = html.charCodeAt(i);
    if (c === 60 /* < */) {
      if (html.startsWith("</span>", i)) {
        if (open.length === 0) return null;
        open.pop();
        i += 7;
        continue;
      }
      OPEN_SPAN.lastIndex = i;
      const m = OPEN_SPAN.exec(html);
      if (m === null) return null;
      open.push(m[0]);
      i += m[0].length;
      continue;
    }
    if (c === 10 /* \n */) {
      lineInChunk += 1;
      if (lineInChunk === linesPerChunk) {
        flush(i, lineInChunk);
        start = i + 1;
        lineInChunk = 0;
      }
    }
    i += 1;
  }
  if (open.length !== 0) return null;
  // The tail is always a chunk — a cut at a newline began a new line, so even
  // an empty remainder is that line (a source ending in a newline has an
  // empty last line, and `chunkLines` gives it its chunk too).
  piece += html.slice(start);
  chunks.push({ html: piece, lines: lineInChunk + 1 });
  return chunks;
}

/** The source text in the same chunks: `linesPerChunk` lines each, joined
 *  with newlines, no trailing newline. `chunkLines(t).length` equals
 *  `splitHighlightHtml(highlight(t)).length` for any `t`. */
export function chunkLines(
  lines: readonly string[],
  linesPerChunk: number = LINES_PER_CHUNK,
): string[] {
  const out: string[] = [];
  for (let at = 0; at < lines.length; at += linesPerChunk) {
    out.push(lines.slice(at, at + linesPerChunk).join("\n"));
  }
  if (out.length === 0) out.push("");
  return out;
}
