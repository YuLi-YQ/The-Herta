/**
 * Guard: no hardcoded CJK characters in renderer source that bypass t().
 *
 * Scans all .ts/.tsx files under src/renderer, excluding:
 *   - i18n/messages/ (the catalogs themselves)
 *   - *.test.ts / *.test.tsx
 *   - this file itself
 *
 * A line is a VIOLATION if it contains a CJK character AND does NOT contain
 * any of the allow-listed tokens that legitimately appear in source:
 *   @板砖, 板砖, 中文, 差分协处理器, 系统
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const THIS_FILE = fileURLToPath(import.meta.url);

// src/renderer directory (this file lives in src/renderer/i18n/)
const RENDERER_ROOT = join(import.meta.dirname, "..");

const CJK_RE = /[一-鿿]/u;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /\/\/.*$/gm;

// Tokens that are legitimately allowed in source (dispatch trigger, Chinese
// endonym, and the D7 discriminant labels used in group-record / ActivityBlock).
const ALLOW_TOKENS = ["@板砖", "板砖", "中文", "差分协处理器", "系统"];

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (/\.test\.(ts|tsx)$/.test(name)) continue;
    // entry.parentPath is the directory containing the file (Node 20+)
    const fullPath = join(entry.parentPath, name);
    // Exclude i18n/messages/ catalog files
    if (fullPath.includes(`i18n${sep}messages`)) continue;
    // Exclude this file itself
    if (fullPath === THIS_FILE) continue;
    results.push(fullPath);
  }
  return results;
}

// 30s: this walks the whole renderer tree; it runs in ~100ms alone but blew
// the default 5s cap twice on 2026-08-31 under full-suite disk contention.
describe("no-hardcoded-cjk", { timeout: 30_000 }, () => {
  it("renderer source has no hardcoded CJK characters outside i18n catalogs and allow-list", () => {
    const files = collectSourceFiles(RENDERER_ROOT);
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
      // Strip block comments then line comments. Blank each comment char but
      // KEEP newlines, so reported violation line numbers stay accurate even
      // after a multi-line block comment.
      const stripped = raw
        .replace(BLOCK_COMMENT_RE, (m) => m.replace(/[^\n]/g, " "))
        .replace(LINE_COMMENT_RE, "");

      const lines = stripped.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!CJK_RE.test(line)) continue;
        if (ALLOW_TOKENS.some((tok) => line.includes(tok))) continue;
        const relPath = relative(RENDERER_ROOT, filePath).replace(/\\/g, "/");
        violations.push(`${relPath}:${i + 1}: ${line.trim()}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
