import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** A stylesheet read off disk, comments removed (cwd-relative; see app-frame-clip.test.ts for why). */
function css(name: string): string {
  const rel = `src/renderer/styles/${name}`;
  for (const base of [".", "packages/gui"]) {
    const p = resolve(process.cwd(), base, rel);
    if (existsSync(p))
      return readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  throw new Error(`${name} not found from cwd`);
}
/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(sheet: string, selector: string): string {
  const at = sheet.indexOf(`${selector} {`);
  if (at < 0) return "";
  return sheet.slice(at, sheet.indexOf("}", at));
}

// Opening a chat whose recent messages carry pictures left the newest line
// and offered 回到最新 (R101). In the packaged app, a layout that lands while
// the switch entrance is still moving the messages made Chromium's scroll
// anchoring pull the transcript up by about 135 px with no input, and
// useFollowOutput rightly reads a far jump without input as the reader
// leaving. While the hook keeps the newest line, the transcript opts out of
// anchoring; once the reader has left, anchoring keeps their place as the text
// above reflows (R103).
describe("chat transcript scroll anchoring (R103)", () => {
  it("is off while the transcript follows its newest line", () => {
    expect(rule(css("herta-chat.css"), ".herta-chat-messages")).toMatch(
      /overflow-anchor:\s*none/,
    );
  });

  it("comes back once the reader is away, to keep their place", () => {
    expect(rule(css("herta-chat.css"), ".herta-chat-messages.is-away")).toMatch(
      /overflow-anchor:\s*auto/,
    );
  });
});
