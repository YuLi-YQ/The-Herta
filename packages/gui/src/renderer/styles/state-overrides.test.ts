import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** A stylesheet read off disk, comments removed (cwd-relative; see app-frame-clip.test.ts). */
function css(name: string): string {
  const rel = `src/renderer/styles/${name}`;
  for (const base of [".", "packages/gui"]) {
    const p = resolve(process.cwd(), base, rel);
    if (existsSync(p))
      return readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  throw new Error(`${name} not found from cwd`);
}

/** Declarations of the rule whose selector is exactly `selector`. */
function rule(sheet: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(
    sheet,
  )?.[1];
  if (body === undefined) throw new Error(`no rule for ${selector}`);
  return body.replace(/\s+/g, " ");
}

describe("state rules that override a broader one (R56)", () => {
  // .app is the upstream frame grid (276px | 1fr, a top-bar row); the error
  // screen carries .app too and must be a single centred cell, or its panel
  // lands in the narrow first column with the title cut off.
  it("makes the startup error screen one cell", () => {
    const body = rule(css("reference-ux.css"), ".app-error");
    expect(body).toContain("grid-template-columns: 1fr");
    expect(body).toContain("grid-template-rows: 1fr");
  });

  // The port's reset rule also matches :hover and outranks the selected
  // rule, which painted the active tab's label in the idle colour.
  it("keeps the selected mode tab's label colour while hovered", () => {
    const body = rule(
      css("lucian-mode-tabs.css"),
      '.u039 .u039-tab[aria-selected="true"]:hover:not(:disabled)',
    );
    expect(body).toContain("color:var(--ux-page)");
  });
});
