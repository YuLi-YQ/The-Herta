import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteKnowledgeStore } from "../store/sqlite-knowledge-store.js";
import { ingestCorpus } from "./ingest-corpus.js";

let workspace: string;
let dataRoot: string;

beforeEach(() => {
  workspace = join(
    tmpdir(),
    `herta-ingest-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  dataRoot = join(workspace, "data");
  mkdirSync(join(dataRoot, "角色图鉴"), { recursive: true });
  mkdirSync(join(dataRoot, "plot_html", "开拓续闻"), { recursive: true });
  writeFileSync(
    join(dataRoot, "角色图鉴", "078_黑塔.html"),
    `<html><body><h1>黑塔</h1><h2>角色故事</h2><p>黑塔小姐其实是一具人偶。</p></body></html>`,
    "utf8",
  );
  writeFileSync(
    join(dataRoot, "plot_html", "开拓续闻", "001_群星.html"),
    `<html><body><h1>天才群星闪耀时</h1><h2>剧情内容</h2><h3>与黑塔交谈</h3>
     <ul>
       <li>黑塔：本人远程操纵此处的人偶。</li>
       <li>开拓者：……</li>
     </ul></body></html>`,
    "utf8",
  );
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe("ingestCorpus", () => {
  it("ingests a small corpus into a fresh DB", async () => {
    const result = await ingestCorpus({
      dataRoot,
      workspaceRoot: workspace,
      force: true,
    });
    expect(result.fileCount).toBe(2);
    expect(result.chunkCount).toBeGreaterThan(0);

    const store = SqliteKnowledgeStore.openOrCreate({
      dbPath: join(workspace, ".herta/knowledge/herta-canon.sqlite"),
      readonly: true,
    });
    const docs = store.rawAll<{ n: number }>(
      "SELECT count(*) AS n FROM documents",
    );
    expect(docs[0]?.n).toBe(2);
    const mentions = store.rawAll<{ n: number }>(
      "SELECT count(*) AS n FROM entity_mentions WHERE referent_entity_id = ?",
      "herta.person.prime",
    );
    expect(mentions[0]?.n).toBeGreaterThan(0);
    store.close();
  });

  it("is idempotent — same source_hash, no duplicate documents", async () => {
    await ingestCorpus({ dataRoot, workspaceRoot: workspace, force: true });
    await ingestCorpus({ dataRoot, workspaceRoot: workspace, force: false });
    const store = SqliteKnowledgeStore.openOrCreate({
      dbPath: join(workspace, ".herta/knowledge/herta-canon.sqlite"),
      readonly: true,
    });
    const docs = store.rawAll<{ n: number }>(
      "SELECT count(*) AS n FROM documents",
    );
    expect(docs[0]?.n).toBe(2);
    store.close();
  });

  it("applies overrides from review/overrides.jsonl", async () => {
    // Pre-create the overrides file BEFORE running ingest, so the loader
    // picks it up. The override forces a bare-黑塔 mention to resolve to
    // station instead of ambiguous.
    const overrideDir = join(workspace, ".herta/knowledge/review");
    mkdirSync(overrideDir, { recursive: true });

    // Compute the chunk ID we expect ingestCorpus to produce so the
    // override targets it. Format: doc:<sha1(relPath)>#<ordinal>.
    const { createHash } = await import("node:crypto");
    const sha1 = (s: string) =>
      createHash("sha1").update(s, "utf8").digest("hex");
    // Add a third fixture whose only Herta mention will be ambiguous
    // without the override. Single paragraph block, ordinal 0.
    const fixtureRel = "data/star_lore/test.html";
    mkdirSync(join(workspace, "data", "star_lore"), { recursive: true });
    writeFileSync(
      join(workspace, fixtureRel),
      `<html><body><h1>无关标题</h1><p>黑塔出现了。</p></body></html>`,
      "utf8",
    );
    const docId = `doc:${sha1(fixtureRel)}`;
    const chunkId = `${docId}#0`;

    writeFileSync(
      join(overrideDir, "overrides.jsonl"),
      `${JSON.stringify({
        target_type: "mention",
        chunk_id: chunkId,
        surface: "黑塔",
        referent_entity_id: "herta.place.space_station",
        confidence: 1.0,
        note: "operator: this is the station",
      })}\n`,
      "utf8",
    );

    await ingestCorpus({ dataRoot, workspaceRoot: workspace, force: true });

    const store = SqliteKnowledgeStore.openOrCreate({
      dbPath: join(workspace, ".herta/knowledge/herta-canon.sqlite"),
      readonly: true,
    });
    const rows = store.rawAll<{
      referent_entity_id: string;
      method: string;
      confidence: number;
    }>(
      "SELECT referent_entity_id, method, confidence FROM entity_mentions WHERE chunk_id = ? AND surface = ?",
      chunkId,
      "黑塔",
    );
    store.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.referent_entity_id).toBe("herta.place.space_station");
    expect(rows[0]?.method).toBe("human_review");
    expect(rows[0]?.confidence).toBe(1.0);
  });

  it("calls injected DeepSeek client for ambiguous chunks and applies the result", async () => {
    mkdirSync(join(workspace, "data", "neutral"), { recursive: true });
    writeFileSync(
      join(workspace, "data", "neutral", "test.html"),
      `<html><body><h1>无关标题</h1><p>黑塔出现了。</p></body></html>`,
      "utf8",
    );

    const fakeClient = {
      chatJson: async (input: { userPayload: string }) => {
        const user = JSON.parse(input.userPayload) as {
          chunks: Array<{ chunk_id: string }>;
        };
        const chunkId = user.chunks[0]?.chunk_id ?? "__missing__";
        return {
          rawJsonText: JSON.stringify({
            chunks: [
              {
                chunk_id: chunkId,
                mentions: [
                  {
                    surface: "黑塔",
                    referent_entity_id: "herta.place.space_station",
                    confidence: 0.9,
                    rationale: "fake-llm",
                  },
                ],
                is_herta_voice_evidence: false,
              },
            ],
          }),
          model: "deepseek-fake",
        };
      },
    };

    await ingestCorpus({
      dataRoot,
      workspaceRoot: workspace,
      force: true,
      llm: {
        client: fakeClient,
        model: "deepseek-fake",
        maxChunks: 100,
        concurrency: 1,
      },
    });

    const store = SqliteKnowledgeStore.openOrCreate({
      dbPath: join(workspace, ".herta/knowledge/herta-canon.sqlite"),
      readonly: true,
    });
    const ambig = store.rawAll<{ n: number }>(
      "SELECT count(*) AS n FROM entity_mentions WHERE referent_entity_id = ?",
      "herta.name.ambiguous",
    );
    const station = store.rawAll<{ n: number }>(
      "SELECT count(*) AS n FROM entity_mentions WHERE referent_entity_id = ? AND method = ?",
      "herta.place.space_station",
      "llm",
    );
    store.close();
    expect(ambig[0]?.n).toBe(0);
    expect(station[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("second run with --force re-extracts (cache wiped with DB)", async () => {
    mkdirSync(join(workspace, "data", "neutral"), { recursive: true });
    writeFileSync(
      join(workspace, "data", "neutral", "test.html"),
      `<html><body><h1>无关标题</h1><p>黑塔出现了。</p></body></html>`,
      "utf8",
    );

    let callCount = 0;
    const fakeClient = {
      chatJson: async (input: { userPayload: string }) => {
        callCount += 1;
        const user = JSON.parse(input.userPayload) as {
          chunks: Array<{ chunk_id: string }>;
        };
        const chunkId = user.chunks[0]?.chunk_id ?? "__missing__";
        return {
          rawJsonText: JSON.stringify({
            chunks: [
              {
                chunk_id: chunkId,
                mentions: [
                  {
                    surface: "黑塔",
                    referent_entity_id: "herta.place.space_station",
                    confidence: 0.9,
                  },
                ],
                is_herta_voice_evidence: false,
              },
            ],
          }),
          model: "deepseek-fake",
        };
      },
    };

    const llmOpts = {
      client: fakeClient,
      model: "deepseek-fake",
      maxChunks: 100,
      concurrency: 1,
    };

    await ingestCorpus({
      dataRoot,
      workspaceRoot: workspace,
      force: true,
      llm: llmOpts,
    });
    const firstCallCount = callCount;
    expect(firstCallCount).toBeGreaterThanOrEqual(1);

    await ingestCorpus({
      dataRoot,
      workspaceRoot: workspace,
      force: true,
      llm: llmOpts,
    });
    expect(callCount).toBeGreaterThan(firstCallCount);
  });

  it("cache hits on second run when --force is NOT used", async () => {
    mkdirSync(join(workspace, "data", "neutral"), { recursive: true });
    writeFileSync(
      join(workspace, "data", "neutral", "test.html"),
      `<html><body><h1>无关标题</h1><p>黑塔出现了。</p></body></html>`,
      "utf8",
    );

    let callCount = 0;
    const fakeClient = {
      chatJson: async (input: { userPayload: string }) => {
        callCount += 1;
        const user = JSON.parse(input.userPayload) as {
          chunks: Array<{ chunk_id: string }>;
        };
        const chunkId = user.chunks[0]?.chunk_id ?? "__missing__";
        return {
          rawJsonText: JSON.stringify({
            chunks: [
              {
                chunk_id: chunkId,
                mentions: [
                  {
                    surface: "黑塔",
                    referent_entity_id: "herta.place.space_station",
                    confidence: 0.9,
                  },
                ],
                is_herta_voice_evidence: false,
              },
            ],
          }),
          model: "deepseek-fake",
        };
      },
    };

    const llmOpts = {
      client: fakeClient,
      model: "deepseek-fake",
      maxChunks: 100,
      concurrency: 1,
    };

    // First run: API gets called.
    await ingestCorpus({
      dataRoot,
      workspaceRoot: workspace,
      force: true,
      llm: llmOpts,
    });
    const after1 = callCount;
    expect(after1).toBeGreaterThanOrEqual(1);

    // Second run without --force: source_hash unchanged → file is skipped → no LLM call.
    await ingestCorpus({
      dataRoot,
      workspaceRoot: workspace,
      force: false,
      llm: llmOpts,
    });
    expect(callCount).toBe(after1);
  });

  it("runs the claim pass by default and reports a non-zero claim count", async () => {
    const result = await ingestCorpus({
      dataRoot,
      workspaceRoot: workspace,
      force: true,
    });
    expect(result.claimsCount).toBeGreaterThan(0);
  });

  it("skips the claim pass when extractClaims is false", async () => {
    const result = await ingestCorpus({
      dataRoot,
      workspaceRoot: workspace,
      force: true,
      extractClaims: false,
    });
    expect(result.claimsCount).toBe(0);
  });

  it("runs the LLM claim pass when llmClaims is provided", async () => {
    const fakeClient = {
      chatJson: async (input: { userPayload: string }) => {
        const u = JSON.parse(input.userPayload) as {
          task: string;
          chunks: Array<{ chunk_id: string; text: string }>;
        };
        if (u.task !== "extract_canon_claims") {
          // Disambiguation request — return empty for that path.
          return {
            rawJsonText: JSON.stringify({ chunks: [] }),
            model: "deepseek-fake",
          };
        }
        const chunkId = u.chunks[0]?.chunk_id ?? "__missing__";
        return {
          rawJsonText: JSON.stringify({
            claims: [
              {
                subject_entity_id: "herta.person.prime",
                predicate: "member_number",
                value: "#83",
                evidence_chunk_ids: [chunkId],
                confidence: 0.91,
              },
            ],
          }),
          model: "deepseek-fake",
        };
      },
    };
    const result = await ingestCorpus({
      dataRoot,
      workspaceRoot: workspace,
      force: true,
      llm: {
        client: fakeClient,
        model: "deepseek-fake",
        maxChunks: 100,
        concurrency: 1,
      },
      llmClaims: {
        client: fakeClient,
        model: "deepseek-fake",
        maxChunks: 50,
        concurrency: 1,
      },
    });
    expect(result.llmClaims?.accepted ?? 0).toBeGreaterThan(0);
  });

  it("skips the LLM claim pass when llmClaims is undefined", async () => {
    const result = await ingestCorpus({
      dataRoot,
      workspaceRoot: workspace,
      force: true,
    });
    expect(result.llmClaims).toBeUndefined();
  });

  it("runs the wiki pass by default and reports a non-zero wikiPagesCount", async () => {
    const result = await ingestCorpus({
      dataRoot,
      workspaceRoot: workspace,
      force: true,
    });
    expect(result.wikiPagesCount).toBeGreaterThan(0);
  });

  it("skips the wiki pass when buildWiki is false", async () => {
    const result = await ingestCorpus({
      dataRoot,
      workspaceRoot: workspace,
      force: true,
      buildWiki: false,
    });
    expect(result.wikiPagesCount).toBe(0);
  });
});
