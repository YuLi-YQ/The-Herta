/**
 * Guard: no hardcoded CJK characters in renderer source that bypass t().
 *
 * Scans all .ts/.tsx files under src/renderer, excluding:
 *   - i18n/messages/ (the catalogs themselves)
 *   - *.test.ts / *.test.tsx
 *   - this file itself
 *   - the Chinese product surfaces named in CHINESE_SURFACES
 *
 * A line is a VIOLATION if it contains a CJK character AND does NOT contain
 * any of the allow-listed tokens that legitimately appear in source:
 *   @板砖, 板砖, 中文, 差分协处理器, 系统
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * The Chinese product surfaces: fixed Chinese chrome, no t() catalog, each
 * listed by exact path (R51). The bilingual legacy areas below keep this
 * guard; their catalog migration is deferred, and a new file anywhere is
 * scanned until it is listed here with a reason.
 */
const CHINESE_SURFACES = new Set([
  // R2: the round workbench, its evidence and the revised settings.
  "components/RoundTwoWorkbench.tsx",
  "components/RoundThreeWorkbench.tsx",
  "components/RecoveryFacts.tsx",
  "components/EvidenceDetail.tsx",
  "components/Settings/ProviderSettings.tsx",
  "components/Settings/SettingsModal.tsx",
  "components/Settings/WindowSettings.tsx",
  // The round workbench's own panels and controls.
  "components/RoundResults.tsx",
  "components/RoundReader.tsx",
  "components/RoundDashboard.tsx",
  "components/ProjectSidebar.tsx",
  "components/ComposerModelPicker.tsx",
  "components/ModeTabs.tsx",
  "components/UserInputCard.tsx",
  "components/WaitingStatus.tsx",
  "components/WebSearch.tsx",
  // The standalone Herta chat (R46 added ChatSidebar).
  "components/HertaChat.tsx",
  "components/ChatSidebar.tsx",
  "components/ChatStorage.tsx",
  "components/ChatMemory.tsx",
  "components/ChatAttachmentPreview.tsx",
  // The chat's Markdown export, in the chat window's words (R124).
  "components/ChatMarkdown.tsx",
  // The /feedback panel and its Markdown, chat and workbench alike (R125).
  "components/FeedbackPanel.tsx",
  // The shared goal panel, status strip and command state (R129).
  "components/GoalPanel.tsx",
  // The workbench plan panel and shared explicit full-access acknowledgement (R130).
  "components/PlanPanel.tsx",
  "components/FullAccessConfirmation.tsx",
  // Workbench recap viewer and explicitly applied chat context drafts (R131).
  "components/WorkbenchCompactPanel.tsx",
  "components/ChatContextPanel.tsx",
  // A message's attachments, chat and workbench alike (R78).
  "components/AttachmentTray.tsx",
  // The composer actions and its / menu (R80).
  "components/ComposerActions.tsx",
  "components/SlashMenu.tsx",
  "components/MessageContent.tsx",
  "components/MessageTime.tsx",
  // JSON prompt plugins (R39).
  "components/Plugins/PluginSettings.tsx",
  "components/Plugins/PromptActionPicker.tsx",
]);

/** Areas built on the t() catalog; never exempted wholesale or by file. */
const BILINGUAL_AREAS = [
  "components/Sidebar/",
  "components/FileViewer/",
  "components/Approval/",
  "components/UtilityRail/",
  "components/Workspace/",
  "components/TopBar/",
];

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

    for (const filePath of files) {
      if (
        CHINESE_SURFACES.has(
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

  it("names Chinese surfaces by exact existing file, never a bilingual area", () => {
    for (const path of CHINESE_SURFACES) {
      expect(path, path).toMatch(/^components\/[\w/]+\.tsx$/);
      expect(existsSync(join(RENDERER_ROOT, path)), path).toBe(true);
      for (const area of BILINGUAL_AREAS)
        expect(path.startsWith(area), `${path} is in ${area}`).toBe(false);
    }
    // A renamed or moved bilingual area must be updated here, not dropped.
    for (const area of BILINGUAL_AREAS)
      expect(existsSync(join(RENDERER_ROOT, area)), area).toBe(true);
  });
});
