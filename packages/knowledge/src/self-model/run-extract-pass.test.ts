import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  DeepSeekChatResponse,
  DeepSeekClient,
  DisambiguationBatchInput,
} from "../llm/types.js";
import type { AntiPattern } from "../schema.js";
import { runExtractPass } from "./run-extract-pass.js";
import type { CorpusManifest } from "./schema.js";

class FakeClient implements DeepSeekClient {
  calls: DisambiguationBatchInput[] = [];
  responses: string[];
  rejectAfter?: number;

  constructor(responses: string[], rejectAfter?: number) {
    this.responses = responses.slice();
    this.rejectAfter = rejectAfter;
  }

  async chatJson(
    input: DisambiguationBatchInput,
  ): Promise<DeepSeekChatResponse> {
    this.calls.push(input);
    if (
      this.rejectAfter !== undefined &&
      this.calls.length > this.rejectAfter
    ) {
      throw new Error("simulated network failure");
    }
    // Dispatch by filename so the mock behaves like a real LLM (which
    // echoes the requested filename in `source`) instead of FIFO —
    // FIFO breaks with concurrency>1 when worker completion order
    // diverges from candidate order. Fall back to shift() for
    // responses that aren't valid JSON or don't declare a source
    // (e.g., the "this is not valid JSON" test case).
    const filename = extractRequestedFilename(input.userPayload);
    if (filename !== null) {
      const matchIdx = this.responses.findIndex((r) =>
        responseSourceMatches(r, filename),
      );
      if (matchIdx !== -1) {
        const [next] = this.responses.splice(matchIdx, 1);
        return { rawJsonText: next as string, model: "fake" };
      }
    }
    const next = this.responses.shift();
    if (next === undefined) throw new Error("FakeClient: no more responses");
    return { rawJsonText: next, model: "fake" };
  }
}

function extractRequestedFilename(userPayload: string): string | null {
  try {
    const parsed = JSON.parse(userPayload) as { filename?: unknown };
    return typeof parsed.filename === "string" ? parsed.filename : null;
  } catch {
    return null;
  }
}

function responseSourceMatches(response: string, filename: string): boolean {
  try {
    const parsed = JSON.parse(response) as { source?: unknown };
    return parsed.source === filename;
  } catch {
    return false;
  }
}

const ANTI_PATTERNS: AntiPattern[] = [
  {
    pattern: "She does not return 你好 greetings.",
    rationale: "Test rationale.",
    evidenceAbsenceClaim: "Test absence claim.",
  },
];

function validResponse(filename: string, factCount = 1): string {
  return JSON.stringify({
    source: filename,
    facts: Array.from({ length: factCount }, (_, i) => ({
      kind: "biography",
      prose: `fact ${i}`,
      evidence_excerpt: "evidence",
      confidence: "high",
    })),
  });
}

describe("runExtractPass", () => {
  let cleanedDir: string;
  let outDir: string;
  let cacheDir: string;

  beforeEach(() => {
    cleanedDir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-cleaned-"));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-out-"));
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-cache-"));

    // Two cleaned-text files, one accepted via manifest.
    fs.writeFileSync(
      path.join(cleanedDir, "019_大黑塔.txt"),
      "== 大黑塔 ==\nShe is...",
      "utf8",
    );
    fs.writeFileSync(
      path.join(cleanedDir, "082_x.txt"),
      "Mission text mentioning 大黑塔.",
      "utf8",
    );
  });

  afterEach(() => {
    fs.rmSync(cleanedDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  function manifest(accepted: string[]): CorpusManifest {
    return {
      version: 1,
      candidates: [
        {
          path: path.join(cleanedDir, "019_大黑塔.txt"),
          mention_count: 50,
          snippet_previews: [],
          accepted: accepted.includes("019_大黑塔.txt"),
          category: "character_page",
        },
        {
          path: path.join(cleanedDir, "082_x.txt"),
          mention_count: 5,
          snippet_previews: [],
          accepted: accepted.includes("082_x.txt"),
          category: "mission",
        },
      ],
    };
  }

  it("processes only accepted candidates", async () => {
    const client = new FakeClient([validResponse("019_大黑塔.html")]);
    const result = await runExtractPass({
      manifest: manifest(["019_大黑塔.txt"]),
      cleanedDir,
      outPath: path.join(outDir, "herta_facts.json"),
      cacheDir,
      antiPatterns: ANTI_PATTERNS,
      client,
      model: "deepseek-v4-pro",
    });
    expect(client.calls.length).toBe(1);
    expect(result.facts.files).toHaveLength(1);
    expect(result.facts.files[0]?.source).toBe("019_大黑塔.html");
    expect(result.facts.failures).toHaveLength(0);
  });

  it("writes herta_facts.json to outPath", async () => {
    const client = new FakeClient([validResponse("019_大黑塔.html")]);
    const outPath = path.join(outDir, "herta_facts.json");
    await runExtractPass({
      manifest: manifest(["019_大黑塔.txt"]),
      cleanedDir,
      outPath,
      cacheDir,
      antiPatterns: ANTI_PATTERNS,
      client,
      model: "deepseek-v4-pro",
    });
    const written = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(written.version).toBe(1);
    expect(written.files).toHaveLength(1);
    expect(written.provenance.passes[0].name).toBe("fact-extract");
    expect(written.provenance.passes[0].model).toBe("deepseek-v4-pro");
  });

  it("caches per-file by content hash; re-run skips API calls", async () => {
    const client1 = new FakeClient([validResponse("019_大黑塔.html")]);
    await runExtractPass({
      manifest: manifest(["019_大黑塔.txt"]),
      cleanedDir,
      outPath: path.join(outDir, "herta_facts.json"),
      cacheDir,
      antiPatterns: ANTI_PATTERNS,
      client: client1,
      model: "deepseek-v4-pro",
    });
    expect(client1.calls.length).toBe(1);

    // Second run with NO scripted responses — should be cache-hit, no API calls.
    const client2 = new FakeClient([]);
    const second = await runExtractPass({
      manifest: manifest(["019_大黑塔.txt"]),
      cleanedDir,
      outPath: path.join(outDir, "herta_facts.json"),
      cacheDir,
      antiPatterns: ANTI_PATTERNS,
      client: client2,
      model: "deepseek-v4-pro",
    });
    expect(client2.calls.length).toBe(0);
    expect(second.facts.files).toHaveLength(1);
  });

  it("re-extracts when cleaned text content changes", async () => {
    const client1 = new FakeClient([validResponse("019_大黑塔.html")]);
    await runExtractPass({
      manifest: manifest(["019_大黑塔.txt"]),
      cleanedDir,
      outPath: path.join(outDir, "herta_facts.json"),
      cacheDir,
      antiPatterns: ANTI_PATTERNS,
      client: client1,
      model: "deepseek-v4-pro",
    });

    // Mutate the cleaned text.
    fs.writeFileSync(
      path.join(cleanedDir, "019_大黑塔.txt"),
      "== 大黑塔 == DIFFERENT",
      "utf8",
    );

    const client2 = new FakeClient([validResponse("019_大黑塔.html")]);
    await runExtractPass({
      manifest: manifest(["019_大黑塔.txt"]),
      cleanedDir,
      outPath: path.join(outDir, "herta_facts.json"),
      cacheDir,
      antiPatterns: ANTI_PATTERNS,
      client: client2,
      model: "deepseek-v4-pro",
    });
    expect(client2.calls.length).toBe(1);
  });

  it("records LLM-call failures in failures[] and continues", async () => {
    const client = new FakeClient(
      [validResponse("019_大黑塔.html"), validResponse("082_x.html")],
      1, // reject after 1 successful call
    );
    const result = await runExtractPass({
      manifest: manifest(["019_大黑塔.txt", "082_x.txt"]),
      cleanedDir,
      outPath: path.join(outDir, "herta_facts.json"),
      cacheDir,
      antiPatterns: ANTI_PATTERNS,
      client,
      model: "deepseek-v4-pro",
    });
    expect(result.facts.files).toHaveLength(1);
    expect(result.facts.failures).toHaveLength(1);
    expect(result.facts.failures[0]?.reason).toContain("simulated");
  });

  it("records validation failures in failures[]", async () => {
    const client = new FakeClient(["this is not valid JSON"]);
    const result = await runExtractPass({
      manifest: manifest(["019_大黑塔.txt"]),
      cleanedDir,
      outPath: path.join(outDir, "herta_facts.json"),
      cacheDir,
      antiPatterns: ANTI_PATTERNS,
      client,
      model: "deepseek-v4-pro",
    });
    expect(result.facts.files).toHaveLength(0);
    expect(result.facts.failures).toHaveLength(1);
    expect(result.facts.failures[0]?.reason).toContain("invalid_json");
  });

  it("dryRun does not call the API and does not write outPath", async () => {
    const client = new FakeClient([]);
    const outPath = path.join(outDir, "herta_facts.json");
    const result = await runExtractPass({
      manifest: manifest(["019_大黑塔.txt", "082_x.txt"]),
      cleanedDir,
      outPath,
      cacheDir,
      antiPatterns: ANTI_PATTERNS,
      client,
      model: "deepseek-v4-pro",
      dryRun: true,
    });
    expect(client.calls.length).toBe(0);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(result.estimatedCalls).toBe(2);
  });

  it("returns estimatedCalls = number of accepted candidates", async () => {
    const client = new FakeClient([
      validResponse("019_大黑塔.html"),
      validResponse("082_x.html"),
    ]);
    const result = await runExtractPass({
      manifest: manifest(["019_大黑塔.txt", "082_x.txt"]),
      cleanedDir,
      outPath: path.join(outDir, "herta_facts.json"),
      cacheDir,
      antiPatterns: ANTI_PATTERNS,
      client,
      model: "deepseek-v4-pro",
    });
    expect(result.estimatedCalls).toBe(2);
  });

  it("creates outPath parent directory if missing", async () => {
    const client = new FakeClient([validResponse("019_大黑塔.html")]);
    const nested = path.join(outDir, "a", "b", "facts.json");
    await runExtractPass({
      manifest: manifest(["019_大黑塔.txt"]),
      cleanedDir,
      outPath: nested,
      cacheDir,
      antiPatterns: ANTI_PATTERNS,
      client,
      model: "deepseek-v4-pro",
    });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("concurrency=1 (default) processes files sequentially", async () => {
    const client = new FakeClient([
      validResponse("019_大黑塔.html"),
      validResponse("082_x.html"),
    ]);
    const result = await runExtractPass({
      manifest: manifest(["019_大黑塔.txt", "082_x.txt"]),
      cleanedDir,
      outPath: path.join(outDir, "facts.json"),
      cacheDir,
      antiPatterns: ANTI_PATTERNS,
      client,
      model: "deepseek-v4-pro",
    });
    expect(result.facts.files).toHaveLength(2);
    expect(result.facts.failures).toHaveLength(0);
  });

  it("concurrency>1 still produces correct output", async () => {
    const client = new FakeClient([
      validResponse("019_大黑塔.html"),
      validResponse("082_x.html"),
    ]);
    const result = await runExtractPass({
      manifest: manifest(["019_大黑塔.txt", "082_x.txt"]),
      cleanedDir,
      outPath: path.join(outDir, "facts.json"),
      cacheDir,
      antiPatterns: ANTI_PATTERNS,
      client,
      model: "deepseek-v4-pro",
      concurrency: 4,
    });
    expect(result.facts.files).toHaveLength(2);
    expect(result.facts.failures).toHaveLength(0);
  });

  it("emits progress events for each file", async () => {
    const events: string[] = [];
    const client = new FakeClient([validResponse("019_大黑塔.html")]);
    await runExtractPass({
      manifest: manifest(["019_大黑塔.txt"]),
      cleanedDir,
      outPath: path.join(outDir, "facts.json"),
      cacheDir,
      antiPatterns: ANTI_PATTERNS,
      client,
      model: "deepseek-v4-pro",
      onProgress: (e) => events.push(e.kind),
    });
    expect(events).toContain("started");
    expect(events).toContain("completed");
  });

  it("emits cache_hit progress when reusing cached output", async () => {
    // First run populates cache.
    const client1 = new FakeClient([validResponse("019_大黑塔.html")]);
    await runExtractPass({
      manifest: manifest(["019_大黑塔.txt"]),
      cleanedDir,
      outPath: path.join(outDir, "facts.json"),
      cacheDir,
      antiPatterns: ANTI_PATTERNS,
      client: client1,
      model: "deepseek-v4-pro",
    });

    // Second run should hit cache.
    const events: string[] = [];
    const client2 = new FakeClient([]);
    await runExtractPass({
      manifest: manifest(["019_大黑塔.txt"]),
      cleanedDir,
      outPath: path.join(outDir, "facts.json"),
      cacheDir,
      antiPatterns: ANTI_PATTERNS,
      client: client2,
      model: "deepseek-v4-pro",
      onProgress: (e) => events.push(e.kind),
    });
    expect(events).toContain("cache_hit");
    expect(client2.calls).toHaveLength(0);
  });

  it("emits failed progress on LLM error and continues", async () => {
    const events: { kind: string; reason?: string }[] = [];
    const client = new FakeClient(
      [validResponse("019_大黑塔.html"), validResponse("082_x.html")],
      1,
    );
    await runExtractPass({
      manifest: manifest(["019_大黑塔.txt", "082_x.txt"]),
      cleanedDir,
      outPath: path.join(outDir, "facts.json"),
      cacheDir,
      antiPatterns: ANTI_PATTERNS,
      client,
      model: "deepseek-v4-pro",
      onProgress: (e) =>
        events.push({
          kind: e.kind,
          reason: e.kind === "failed" ? e.reason : undefined,
        }),
    });
    const failedEvents = events.filter((e) => e.kind === "failed");
    expect(failedEvents.length).toBe(1);
  });
});
