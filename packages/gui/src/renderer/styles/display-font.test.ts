import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** A file under packages/gui, read off disk (cwd-relative; see app-frame-clip.test.ts). */
function gui(rel: string): Buffer {
  for (const base of [".", "packages/gui"]) {
    const p = resolve(process.cwd(), base, rel);
    if (existsSync(p)) return readFileSync(p);
  }
  throw new Error(`${rel} not found from cwd`);
}
const manifest = JSON.parse(
  gui("src/renderer/assets/fonts/herta-display.json").toString("utf8"),
) as { lines: string[]; chars: string; sha256: string; bytes: number };

/** Where each subset line is shown. */
const SHOWN: Record<string, string> = {
  "把难题拿来，别让我无聊。": "src/renderer/components/RoundThreeWorkbench.tsx",
  "这次，有什么有趣的事？": "src/renderer/components/HertaChat.tsx",
  "The Herta": "src/renderer/components/RoundThreeWorkbench.tsx",
  "THE HERTA / WORKBENCH": "src/renderer/components/RoundThreeWorkbench.tsx",
};

// R76: the display face is a subset cut to these lines. A line edited in its
// component without re-running scripts/fetch-display-font.mjs would show its
// new characters in the fallback face; these checks catch that first.
describe("display face subset (R76)", () => {
  it("covers every character of every line it sets", () => {
    for (const line of manifest.lines)
      for (const char of line)
        expect(manifest.chars.includes(char), `${line}: ${char}`).toBe(true);
  });

  it("still sets lines that the interface shows, verbatim", () => {
    // Retired labels may remain in the existing font subset; every active
    // display line must still be covered without rebuilding a binary asset.
    expect(manifest.lines).toEqual(expect.arrayContaining(Object.keys(SHOWN)));
    for (const [line, file] of Object.entries(SHOWN))
      expect(gui(file).toString("utf8"), `${line} in ${file}`).toContain(line);
  });

  it("ships the exact subset the manifest records", () => {
    const font = gui("src/renderer/assets/fonts/herta-display.woff2");
    expect(font.length).toBe(manifest.bytes);
    expect(createHash("sha256").update(font).digest("hex")).toBe(manifest.sha256);
  });

  it("applies only to the observatory appearance, falling back to the system sans", () => {
    const css = gui("src/renderer/styles/display-font.css").toString("utf8");
    expect(css).toContain('src: url("../assets/fonts/herta-display.woff2")');
    const rule = css.slice(css.indexOf(':root[data-appearance="observatory"]'));
    expect(rule).toContain('font-family: "Herta Display", "Segoe UI Variable", "Microsoft YaHei UI", sans-serif');
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/(^|\})\s*\.herta-[^{]*\{[^}]*Herta Display/);
  });
});
