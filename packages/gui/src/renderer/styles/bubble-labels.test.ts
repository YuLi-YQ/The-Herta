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

// The user's bubble shows no 你 in either surface; its side says who wrote
// it. The label stays readable to screen readers in both (R73).
describe("user bubble labels (R73)", () => {
  for (const [sheet, selector] of [
    ["herta-chat.css", ".herta-chat-message.is-user > strong"],
    ["round-ten.css", ".herta-r10 .herta-transcript > article.herta-user > strong"],
  ] as const) {
    it(`hides ${selector} from sight only`, () => {
      const body = rule(css(sheet), selector);
      expect(body, selector).toContain("clip-path: inset(50%)");
      expect(body).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    });
  }

  it("shares the user's bubble treatment across both conversation hosts", () => {
    const body = rule(
      css("conversation.css"),
      ':root[data-appearance="observatory"] :is(.herta-transcript > article.herta-user, .herta-chat-message.is-user)',
    );
    expect(body).toContain(
      "border-radius: 16px 16px 4px 16px",
    );
    expect(body).toContain("background: var(--herta-panel)");
  });
});
