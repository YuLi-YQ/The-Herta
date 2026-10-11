import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DeepSeekClient } from "../llm/types.js";
import type { AntiPattern } from "../schema.js";
import { parseExtractionOutput } from "./extract-output-validator.js";
import { buildExtractionPrompt } from "./extract-prompt.js";
import type { CorpusManifest, FileFacts, HertaFacts } from "./schema.js";

export interface RunExtractPassInput {
  /** Manifest from Pass 0.5; only `accepted: true` candidates are processed. */
  manifest: CorpusManifest;
  /** Directory containing cleaned `<basename>.txt` files from Pass 0. */
  cleanedDir: string;
  /** Where the aggregated `herta_facts.json` is written. Parents auto-created. */
  outPath: string;
  /** Per-file cache directory (sha256 + JSON pairs). */
  cacheDir: string;
  /** Voice profile anti-patterns embedded in the prompt. */
  antiPatterns: ReadonlyArray<AntiPattern>;
  /** DS V4 Pro client. */
  client: DeepSeekClient;
  /** Model identifier (e.g., "deepseek-v4-pro"). */
  model: string;
  /** When true: no API calls, no outPath write. Returns estimatedCalls. */
  dryRun?: boolean;
  /** Override clock for deterministic generated_at in tests. */
  now?: () => Date;
  /**
   * Number of files to process concurrently. Default 1 (sequential).
   * Higher values parallelize the LLM calls; the existing voice
   * pipeline uses 2 for ingest. 4-8 is a good range for fact extraction
   * (each call is 10-30s, mostly waiting on the model).
   */
  concurrency?: number;
  /** Optional per-file callback fired right after a file completes. */
  onProgress?: (event: ExtractProgressEvent) => void;
}

export type ExtractProgressEvent =
  | { kind: "started"; source: string; index: number; total: number }
  | { kind: "cache_hit"; source: string; index: number; total: number }
  | {
      kind: "completed";
      source: string;
      index: number;
      total: number;
      factCount: number;
      durationMs: number;
    }
  | {
      kind: "failed";
      source: string;
      index: number;
      total: number;
      reason: string;
    };

export interface RunExtractPassResult {
  facts: HertaFacts;
  estimatedCalls: number;
  cacheHits: number;
}

const PASS_NAME = "fact-extract" as const;

export async function runExtractPass(
  input: RunExtractPassInput,
): Promise<RunExtractPassResult> {
  const accepted = input.manifest.candidates.filter((c) => c.accepted);
  const estimatedCalls = accepted.length;

  if (input.dryRun) {
    const empty: HertaFacts = {
      version: 1,
      generated_at: (input.now ?? (() => new Date()))().toISOString(),
      provenance: { passes: [{ name: PASS_NAME, model: input.model }] },
      files: [],
      failures: [],
    };
    return { facts: empty, estimatedCalls, cacheHits: 0 };
  }

  await fs.mkdir(input.cacheDir, { recursive: true });
  await fs.mkdir(path.dirname(input.outPath), { recursive: true });

  const files: FileFacts[] = [];
  const failures: HertaFacts["failures"] = [];
  let cacheHits = 0;

  const concurrency = Math.max(1, input.concurrency ?? 1);
  const total = accepted.length;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= total) return;
      const candidate = accepted[index];
      if (candidate === undefined) return;

      const basename = path.basename(
        candidate.path,
        path.extname(candidate.path),
      );
      const cleanedPath = path.join(input.cleanedDir, `${basename}.txt`);
      const sourceFilename = `${basename}.html`;

      let cleanedText: string;
      try {
        cleanedText = await fs.readFile(cleanedPath, "utf8");
      } catch (err) {
        const reason = `read cleaned-text failed: ${(err as Error).message}`;
        failures.push({ source: sourceFilename, reason });
        input.onProgress?.({
          kind: "failed",
          source: sourceFilename,
          index,
          total,
          reason,
        });
        continue;
      }

      const sha = createHash("sha256").update(cleanedText).digest("hex");
      const cacheJsonPath = path.join(input.cacheDir, `${basename}.json`);
      const cacheShaPath = path.join(input.cacheDir, `.${basename}.sha256`);

      // Check cache.
      const cached = await readCache(cacheJsonPath, cacheShaPath, sha);
      if (cached !== null) {
        files.push(cached);
        cacheHits += 1;
        input.onProgress?.({
          kind: "cache_hit",
          source: sourceFilename,
          index,
          total,
        });
        continue;
      }

      // Cache miss — call the LLM.
      input.onProgress?.({
        kind: "started",
        source: sourceFilename,
        index,
        total,
      });
      const startedAt = Date.now();

      const prompt = buildExtractionPrompt({
        filename: sourceFilename,
        category: candidate.category,
        cleanedText,
        antiPatterns: input.antiPatterns,
      });

      let raw: string;
      try {
        const response = await input.client.chatJson({
          systemPrompt: prompt.systemPrompt,
          userPayload: prompt.userPayload,
          model: input.model,
        });
        raw = response.rawJsonText;
      } catch (err) {
        const reason = (err as Error).message;
        failures.push({ source: sourceFilename, reason });
        input.onProgress?.({
          kind: "failed",
          source: sourceFilename,
          index,
          total,
          reason,
        });
        continue;
      }

      const parsed = parseExtractionOutput(raw, {
        expectedSource: sourceFilename,
        sourceText: cleanedText,
      });

      if (!parsed.ok) {
        const reason = `${parsed.code}: ${parsed.message}`;
        failures.push({ source: sourceFilename, reason });
        input.onProgress?.({
          kind: "failed",
          source: sourceFilename,
          index,
          total,
          reason,
        });
        continue;
      }

      files.push(parsed.fileFacts);
      await writeCache(cacheJsonPath, cacheShaPath, sha, parsed.fileFacts);
      input.onProgress?.({
        kind: "completed",
        source: sourceFilename,
        index,
        total,
        factCount: parsed.fileFacts.facts.length,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const facts: HertaFacts = {
    version: 1,
    generated_at: (input.now ?? (() => new Date()))().toISOString(),
    provenance: { passes: [{ name: PASS_NAME, model: input.model }] },
    files,
    failures,
  };

  await fs.writeFile(
    input.outPath,
    `${JSON.stringify(facts, null, 2)}\n`,
    "utf8",
  );

  return { facts, estimatedCalls, cacheHits };
}

async function readCache(
  jsonPath: string,
  shaPath: string,
  expectedSha: string,
): Promise<FileFacts | null> {
  try {
    const previousSha = (await fs.readFile(shaPath, "utf8")).trim();
    if (previousSha !== expectedSha) return null;
    const json = await fs.readFile(jsonPath, "utf8");
    return JSON.parse(json) as FileFacts;
  } catch {
    return null;
  }
}

async function writeCache(
  jsonPath: string,
  shaPath: string,
  sha: string,
  fileFacts: FileFacts,
): Promise<void> {
  await fs.writeFile(
    jsonPath,
    `${JSON.stringify(fileFacts, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(shaPath, sha, "utf8");
}
