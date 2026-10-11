import { describe, expect, it } from "vitest";
import { highlightToHtml } from "./highlight.js";
import {
  chunkLines,
  LINES_PER_CHUNK,
  splitHighlightHtml,
} from "./highlight-chunks.js";

/** The text a highlight.js answer carries, unescaped — what the reader sees. */
const textOf = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

const opens = (html: string): number => (html.match(/<span /g) ?? []).length;
const closes = (html: string): number => (html.match(/<\/span>/g) ?? []).length;

const hl = (source: string): string => {
  const html = highlightToHtml(source, "typescript");
  if (html === null) throw new Error("no highlight");
  return html;
};

describe("splitHighlightHtml / chunkLines (ADR 0068 §13)", () => {
  it("cuts at the same lines as chunkLines, every piece balanced, the text intact — a span that crosses the cut is closed and reopened", () => {
    const source = [
      "const a = 1;",
      "/* a block comment",
      "   that runs on",
      "   for four lines",
      "   and ends here */",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture IS source text — a template literal with a placeholder, for the span that crosses the cut
      'const b = `template ${a} "quoted" <tag> & more',
      "  still the template`;",
      "export { a, b };",
    ].join("\n");
    const lines = source.split("\n");
    const plain = chunkLines(lines, 3);
    const pieces = splitHighlightHtml(hl(source), 3);
    expect(pieces).not.toBeNull();
    if (pieces === null) return;
    expect(pieces.map((p) => p.lines)).toEqual([3, 3, 2]);
    expect(pieces).toHaveLength(plain.length);
    for (const [k, piece] of pieces.entries()) {
      expect(opens(piece.html), `piece ${k} balanced`).toBe(closes(piece.html));
      expect(textOf(piece.html), `piece ${k} text`).toBe(plain[k]);
      expect(piece.html.endsWith("\n")).toBe(false);
    }
    // The comment spans lines 2–5: piece 0 closes it, piece 1 reopens it.
    expect(pieces[0]?.html.endsWith("</span>")).toBe(true);
    expect(pieces[1]?.html.startsWith('<span class="hljs-comment">')).toBe(
      true,
    );
    // Rejoined, the pieces read as the whole source.
    expect(pieces.map((p) => textOf(p.html)).join("\n")).toBe(source);
  });

  it("a source ending in a newline has an empty last line, and both sides give it a chunk", () => {
    const source = "const a = 1;\n";
    const lines = source.split("\n");
    expect(chunkLines(lines, 1)).toEqual(["const a = 1;", ""]);
    const pieces = splitHighlightHtml(hl(source), 1);
    expect(pieces?.map((p) => [textOf(p.html), p.lines])).toEqual([
      ["const a = 1;", 1],
      ["", 1],
    ]);
  });

  it("fewer lines than a chunk: one piece, the answer untouched", () => {
    const html = hl("const a = 1;\nconst b = 2;");
    expect(splitHighlightHtml(html)).toEqual([{ html, lines: 2 }]);
    expect(chunkLines(["x"])).toEqual(["x"]);
    expect(chunkLines([])).toEqual([""]);
  });

  it("the piece count is ceil(lines / LINES_PER_CHUNK) on both sides", () => {
    const n = LINES_PER_CHUNK * 4 + 37;
    const lines = Array.from({ length: n }, (_, i) => `let v${i} = ${i};`);
    const pieces = splitHighlightHtml(hl(lines.join("\n")));
    expect(pieces?.length).toBe(5);
    expect(pieces?.map((p) => p.lines)).toEqual([
      LINES_PER_CHUNK,
      LINES_PER_CHUNK,
      LINES_PER_CHUNK,
      LINES_PER_CHUNK,
      37,
    ]);
    expect(chunkLines(lines)).toHaveLength(5);
    expect(pieces?.map((p) => textOf(p.html)).join("\n")).toBe(
      lines.join("\n"),
    );
  });

  it("refuses what is not highlight.js's shape", () => {
    expect(splitHighlightHtml("<b>x</b>")).toBeNull();
    expect(splitHighlightHtml("<span>x</span>")).toBeNull();
    expect(splitHighlightHtml('<span class="a" id="b">x</span>')).toBeNull();
    expect(splitHighlightHtml("x</span>")).toBeNull();
    expect(splitHighlightHtml('<span class="a">x')).toBeNull();
  });
});
