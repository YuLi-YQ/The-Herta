import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CandidateCategory, CorpusCandidate } from "./schema.js";

const HERTA_TRIGGERS: readonly string[] = [
  "大黑塔",
  "天才俱乐部 #83",
  "天才俱乐部#83",
  "Herta 空间站",
  "黑塔空间站",
  "黑塔的人偶",
  "黑塔",
];

const SNIPPET_RADIUS = 40;

export interface CorpusGrepInput {
  /** Root directory to walk recursively (e.g., `data/`). */
  root: string;
  /** Cap on snippet previews per file. Default 5. */
  maxPreviewsPerFile?: number;
}

/**
 * Categorize a file by its path. Heuristic only; the returned category
 * is the best guess based on directory location.
 */
export function categorizeFromPath(p: string): CandidateCategory {
  const norm = p.replace(/\\/g, "/");
  if (norm.includes("/角色图鉴/")) return "character_page";
  if (norm.includes("/book_html/")) return "book";
  if (norm.includes("/星海纪闻/")) return "station_lore";
  if (norm.includes("/编年史/")) return "chronicle";
  if (norm.includes("/plot_html/模拟宇宙/")) return "sim_universe";
  if (norm.includes("/plot_html/")) return "mission";
  return "incidental_mention";
}

/**
 * Walk the corpus root, search every HTML file for Herta-trigger phrases,
 * return candidates with mention counts and snippet previews. Default
 * `accepted: false` — a human reviews and flips the flags.
 */
export async function grepCorpusForHerta(
  input: CorpusGrepInput,
): Promise<CorpusCandidate[]> {
  const max = input.maxPreviewsPerFile ?? 5;
  const candidates: CorpusCandidate[] = [];
  for await (const file of walkHtml(input.root)) {
    const content = await fs.readFile(file, "utf8");
    const { count, previews } = countAndPreview(content, max);
    if (count === 0) continue;
    candidates.push({
      path: file,
      mention_count: count,
      snippet_previews: previews,
      accepted: false,
      category: categorizeFromPath(file),
    });
  }
  return candidates.sort((a, b) => b.mention_count - a.mention_count);
}

async function* walkHtml(root: string): AsyncGenerator<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkHtml(full);
    } else if (entry.isFile() && full.toLowerCase().endsWith(".html")) {
      yield full;
    }
  }
}

function countAndPreview(
  content: string,
  maxPreviews: number,
): { count: number; previews: string[] } {
  // Count: sum of trigger occurrences (case sensitive — Chinese has no case).
  let count = 0;
  for (const trigger of HERTA_TRIGGERS) {
    const re = new RegExp(escapeRegex(trigger), "g");
    count += (content.match(re) ?? []).length;
  }

  // Previews: extract up to maxPreviews snippets, each ~80 chars centered on
  // a trigger. Walk the trigger list in order so the most-specific trigger
  // (大黑塔) anchors first.
  const previews: string[] = [];
  for (const trigger of HERTA_TRIGGERS) {
    if (previews.length >= maxPreviews) break;
    let from = 0;
    while (previews.length < maxPreviews) {
      const idx = content.indexOf(trigger, from);
      if (idx === -1) break;
      const lo = Math.max(0, idx - SNIPPET_RADIUS);
      const hi = Math.min(
        content.length,
        idx + trigger.length + SNIPPET_RADIUS,
      );
      const snippet = content.slice(lo, hi).replace(/\s+/g, " ").trim();
      if (!previews.includes(snippet)) previews.push(snippet);
      from = idx + trigger.length;
    }
  }
  return { count, previews };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
