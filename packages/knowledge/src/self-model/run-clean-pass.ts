import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseHtmlDocument } from "../html/parse-html.js";
import { extractFromBrStructure } from "./br-fallback-extractor.js";
import { formatCleanedText } from "./format-cleaned-text.js";

export interface CleanPassInput {
  /** Absolute paths to source HTML files. */
  sources: readonly string[];
  /** Where cleaned `.txt` files are written. Created if missing. */
  outDir: string;
  /** Where content-hash cache files live. Typically same as outDir. */
  cacheDir: string;
}

export interface CleanedFile {
  source: string;
  outPath: string;
  cacheHit: boolean;
  sha256: string;
  /** True when parseHtmlDocument returned 0 blocks and the br-fallback ran. */
  usedFallback?: boolean;
}

export interface CleanPassResult {
  cleaned: CleanedFile[];
}

export async function runCleanPass(
  input: CleanPassInput,
): Promise<CleanPassResult> {
  await fs.mkdir(input.outDir, { recursive: true });
  await fs.mkdir(input.cacheDir, { recursive: true });

  const cleaned: CleanedFile[] = [];

  for (const src of input.sources) {
    const html = await fs.readFile(src, "utf8");
    const sha = createHash("sha256").update(html).digest("hex");
    const basename = path.basename(src, path.extname(src));
    const outPath = path.join(input.outDir, `${basename}.txt`);
    const cachePath = path.join(input.cacheDir, `.${basename}.sha256`);

    let cacheHit = false;
    try {
      const previousSha = await fs.readFile(cachePath, "utf8");
      if (previousSha.trim() === sha) {
        // Verify the output is still present; if not, re-run.
        try {
          await fs.access(outPath);
          cacheHit = true;
        } catch {
          cacheHit = false;
        }
      }
    } catch {
      // No cache yet — proceed to clean.
    }

    let usedFallback = false;
    if (!cacheHit) {
      let parsed = parseHtmlDocument(html);
      if (parsed.blocks.length === 0) {
        // Some HSR wiki pages (notably sim_universe entries) put their
        // dialogue inside nested <div> + <br/> structures that the
        // canonical parser doesn't match. Fall back to the <br>-aware
        // extractor when the canonical pass returns no blocks.
        parsed = extractFromBrStructure(html);
        usedFallback = parsed.blocks.length > 0;
      }
      const text = formatCleanedText(parsed);
      await fs.writeFile(outPath, text, "utf8");
      await fs.writeFile(cachePath, sha, "utf8");
    }

    cleaned.push({
      source: src,
      outPath,
      cacheHit,
      sha256: sha,
      usedFallback,
    });
  }

  return { cleaned };
}
