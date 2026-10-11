import { Marked, type Token, type Tokens } from "marked";

const parser = new Marked({ gfm: true, breaks: true, async: false });
export const CODE_PAGE_SIZE = 8000;

export function messageTokens(text: string): Token[] {
  const tokens = parser.lexer(text);
  // marked normalizes CRLF before lexing. Map top-level raw ranges back to
  // the source so copying never normalizes the user's actual code bytes.
  let offset = 0;
  for (const token of tokens) {
    const length = token.raw.length;
    const start = offset;
    let normalized = 0;
    while (offset < text.length && normalized < length) {
      if (text[offset] === "\r" && text[offset + 1] === "\n") offset++;
      offset++;
      normalized++;
    }
    if (token.type === "code") token.raw = text.slice(start, offset);
    if (token.type === "blockquote" || token.type === "list") {
      const original = text.slice(start, offset);
      // Container markers are not part of code. Restore each physical source
      // line's terminator after marked removes quote/list indentation.
      let sourceCursor = 0;
      const restore = (children: Token[]) => {
        for (const child of children) {
          if (child.type === "code") {
            const parts = child.raw.split("\n");
            if (parts.at(-1) === "") parts.pop();
            let restored = "";
            for (const part of parts) {
              while (sourceCursor < original.length) {
                const end = original.indexOf("\n", sourceCursor);
                const next = end === -1 ? original.length : end + 1;
                const physical = original.slice(
                  sourceCursor,
                  end === -1 ? next : end,
                );
                sourceCursor = next;
                if (physical.replace(/\r$/, "").endsWith(part)) {
                  restored +=
                    part +
                    (end === -1 ? "" : physical.endsWith("\r") ? "\r\n" : "\n");
                  break;
                }
              }
            }
            if (restored) child.raw = restored;
          } else if (child.type === "list") {
            for (const item of child.items) restore(item.tokens);
          } else if ("tokens" in child && Array.isArray(child.tokens)) {
            restore(child.tokens);
          }
        }
      };
      if (token.type === "blockquote")
        restore((token as Tokens.Blockquote).tokens);
      else
        for (const item of (token as Tokens.List).items) restore(item.tokens);
    }
  }
  return tokens;
}

/** Preserve original line endings, indentation and final newline inside a fence. */
export function exactCode(raw: string, fallback: string): string {
  const opening = /^( {0,3})(`{3,}|~{3,})[^\r\n]*(?:\r\n|\n|\r)/.exec(raw);
  if (!opening) {
    // Indented Markdown code has no fence, but still preserves line endings.
    return /^(?: {4}|\t)/.test(raw)
      ? raw.replace(/^(?: {4}|\t)/gm, "")
      : fallback;
  }
  const body = raw.slice(opening[0].length);
  const fence = opening[2] ?? "```";
  const closing = new RegExp(
    `^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\r\\n|\\n|\\r)?$`,
    "m",
  );
  const match = closing.exec(body);
  return match ? body.slice(0, match.index) : body;
}

export function safeMessageUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function codePage(text: string, page: number): string {
  let start = page * CODE_PAGE_SIZE;
  let end = Math.min(text.length, start + CODE_PAGE_SIZE);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? "")) start--;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--;
  return text.slice(start, end);
}
