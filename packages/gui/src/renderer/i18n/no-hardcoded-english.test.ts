/**
 * Guard: no hardcoded ENGLISH chrome in renderer JSX text nodes.
 *
 * Symmetric to no-hardcoded-cjk.test.ts (audit 2026-07-10 §6): a guard
 * existed for Chinese chrome but not English, and that asymmetry is exactly
 * how un-localized English result rows shipped once. English can't be
 * whole-line-scanned like CJK (identifiers, props, and logic are
 * legitimately English), so the scope here is narrower: LITERAL JSX text
 * nodes — `>Some English<` — in .tsx files, the shape a hardcoded label
 * takes. Text that goes through t() renders as `{t("…")}` and never
 * matches.
 *
 * Scans all .tsx files under src/renderer, excluding i18n/messages/ and
 * *.test.tsx. Allow-listed tokens cover brand/technical strings that are
 * deliberately not localized.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// src/renderer directory (this file lives in src/renderer/i18n/)
const RENDERER_ROOT = join(import.meta.dirname, "..");

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /\/\/.*$/gm;
// A literal JSX text node on one line: between a `>` and the next `<`, no
// expression braces, containing at least two consecutive ASCII letters.
// `(?<!=)` skips the `>` of `=>` so arrow-function return types
// (`() => Promise<T>`) don't read as text nodes. `(?!\()` skips a `>` that
// closes a GENERIC parameter list — `function Select<V extends string>(props:
// SelectProps<V>)` read as the text node `(props: SelectProps` (2026-07-12).
// Trade-off: a real label STARTING with "(" would slip past; none exists,
// and t()-routed text never matches anyway.
const JSX_TEXT_NODE_RE = /(?<!=)>(?!\()([^<>{}\n]*[A-Za-z]{2,}[^<>{}\n]*)</g;

// Deliberately-unlocalized strings: brand/product tokens, technical API
// names shown as-is, and the language's own endonym in the picker (the CJK
// guard allow-lists 中文 for the same reason).
const ALLOW_TOKENS = [
  "Herta",
  "HRT-001",
  "DeepSeek",
  "window.herta",
  "platform.deepseek.com",
  "platform.minimaxi.com",
  "English",
];

function collectTsxFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!/\.tsx$/.test(name)) continue;
    if (/\.test\.tsx$/.test(name)) continue;
    const fullPath = join(entry.parentPath, name);
    if (fullPath.includes(`i18n${sep}messages`)) continue;
    results.push(fullPath);
  }
  return results;
}

// 30s like its cjk sibling: a whole-renderer-tree walk that runs in ~250ms
// alone but is at the mercy of full-suite disk contention (2026-08-31).
describe("no-hardcoded-english", { timeout: 30_000 }, () => {
  it("renderer JSX text nodes carry no hardcoded English outside the allow-list", () => {
    const files = collectTsxFiles(RENDERER_ROOT);
    const violations: string[] = [];

    // R2 intentionally ships fixed Chinese chrome in these exact new/revised surfaces.
    // Existing bilingual legacy surfaces retain this guard; catalog migration is deferred.
    const ROUND_TWO_CHINESE_ONLY = new Set([
      "components/RoundTwoWorkbench.tsx",
      "components/RoundThreeWorkbench.tsx",
      "components/RecoveryFacts.tsx",
      "components/EvidenceDetail.tsx",
      "components/Settings/ProviderSettings.tsx",
      "components/Settings/SettingsModal.tsx",
      "components/Settings/WindowSettings.tsx",
    ]);
    for (const filePath of files) {
      if (
        ROUND_TWO_CHINESE_ONLY.has(
          relative(RENDERER_ROOT, filePath).replace(/\\/g, "/"),
        )
      )
        continue;
      const raw = readFileSync(filePath, "utf-8");
      const stripped = raw
        .replace(BLOCK_COMMENT_RE, (m) => m.replace(/[^\n]/g, " "))
        .replace(LINE_COMMENT_RE, "");

      const lines = stripped.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        for (const match of line.matchAll(JSX_TEXT_NODE_RE)) {
          const text = (match[1] ?? "").trim();
          if (text.length === 0) continue;
          if (ALLOW_TOKENS.some((tok) => text.includes(tok))) continue;
          const relPath = relative(RENDERER_ROOT, filePath).replace(/\\/g, "/");
          violations.push(`${relPath}:${i + 1}: >${text}<`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
