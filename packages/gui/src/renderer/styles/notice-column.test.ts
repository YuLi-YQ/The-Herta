import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** A file under packages/gui, read off disk (cwd-relative; see app-frame-clip.test.ts). */
function gui(rel: string): string {
  for (const base of [".", "packages/gui"]) {
    const p = resolve(process.cwd(), base, rel);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error(`${rel} not found from cwd`);
}

// R79: the workbench's short status line ("已请求取消……") used to be a bare <p> in the
// content area, so it sat at the area's left edge, far from the centred transcript.
describe("workbench notice column (R79)", () => {
  it("renders the notice with its own class", () => {
    expect(gui("src/renderer/components/RoundThreeWorkbench.tsx")).toContain(
      '<p className="herta-notice" role="status">',
    );
  });
  it("sizes the notice like the error cards: the transcript's column, centred", () => {
    const css = gui("src/renderer/styles/round-three.css");
    const rule = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf("}", at));
    };
    for (const selector of [".herta-r3 .herta-notice", ".herta-r3 .herta-error-card"]) {
      const body = rule(selector);
      expect(body).toContain("width: calc(100% - 2 * var(--herta-content-gutter));");
      expect(body).toContain("max-width: var(--herta-content-width);");
      expect(body).toContain("margin: 8px auto;");
    }
  });
});
