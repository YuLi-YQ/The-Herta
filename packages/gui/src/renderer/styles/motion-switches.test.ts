import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** motion.css read off disk (cwd-relative; see app-frame-clip.test.ts for why). */
const CSS = ((): string => {
  const rel = "src/renderer/styles/motion.css";
  for (const base of [".", "packages/gui"]) {
    const p = resolve(process.cwd(), base, rel);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error("motion.css not found from cwd");
})().replace(/\/\*[\s\S]*?\*\//g, "");

/** The scopes the in-app "off" switch and the OS reduce-motion request each
 *  silence: the selector list of every `:is(...)` in their blocks. */
function scopes(block: string): Set<string> {
  const lists = [...block.matchAll(/:is\(([^)]*)\)/g)].map((m) => m[1] ?? "");
  return new Set(lists.flatMap((l) => l.split(",").map((s) => s.trim())));
}

describe("motion switches cover every animated surface (R54)", () => {
  const off = scopes(
    CSS.split("\n")
      .filter((line) => line.startsWith(':root[data-motion="off"]'))
      .join("\n"),
  );
  const reduced = scopes(
    /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(
      CSS,
    )?.[1] ?? "",
  );

  it("silences the same surfaces for the app switch and the OS request", () => {
    expect(off.size).toBeGreaterThan(0);
    expect([...off].sort()).toEqual([...reduced].sort());
  });

  // Portaled to <body>, so outside .herta-shell: each must be named, or the
  // in-app switch leaves its fade running (the image viewer did until R54).
  it("names the overlays that render outside the shell", () => {
    for (const overlay of [".round-hover-preview", ".lightbox-backdrop"])
      expect(off.has(overlay), overlay).toBe(true);
    expect(off.has(".herta-shell")).toBe(true);
  });
});

describe("text surfacing stays behind the same switches (R71)", () => {
  const allowed =
    /@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}/.exec(
      CSS,
    )?.[1] ?? "";

  it("animates only a streaming reply and the empty greetings, inside the no-preference block", () => {
    for (const target of [
      ".message-content[data-streaming]",
      ".herta-chat-empty",
      ".herta-welcome-copy",
    ]) {
      expect(allowed, target).toContain(target);
      expect(CSS.replace(allowed, ""), target).not.toContain(target);
    }
  });

  it("guards every text animation by the observatory appearance and the in-app switch", () => {
    const rules = allowed
      .split("}")
      .filter((rule) => /herta-text-rise|animation-delay/.test(rule));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules)
      expect(rule).toContain(
        ':root[data-appearance="observatory"]:not([data-motion="off"])',
      );
  });
});
