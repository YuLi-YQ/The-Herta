import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HERTA_PERSON_PRIME } from "../schema.js";
import { SqliteKnowledgeStore } from "../store/sqlite-knowledge-store.js";
import { mkTempKnowledgeDb } from "../testing/mk-temp-knowledge-db.js";
import type { CliDeps } from "./herta-knowledge.js";
import { runKnowledgeCli } from "./herta-knowledge.js";

let workspace: string;
beforeEach(() => {
  workspace = join(
    tmpdir(),
    `herta-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(workspace, "data", "角色图鉴"), { recursive: true });
  writeFileSync(
    join(workspace, "data", "角色图鉴", "078_黑塔.html"),
    `<html><body><h1>黑塔</h1><h2>角色故事</h2><p>黑塔小姐其实是一具人偶。</p></body></html>`,
    "utf8",
  );
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe("runKnowledgeCli", () => {
  it("prints usage when no subcommand given", async () => {
    const logs: string[] = [];
    const code = await runKnowledgeCli([], {
      cwd: workspace,
      log: (l) => logs.push(l),
      err: (l) => logs.push(l),
    });
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/usage/i);
  });

  it("glossary looks up aligned CN/EN pairs from the TextMap dir", async () => {
    mkdirSync(join(workspace, "data", "textmap"), { recursive: true });
    writeFileSync(
      join(workspace, "data", "textmap", "TextMapCHS.json"),
      JSON.stringify({ "100": "大黑塔", "200": "大黑塔的实验" }),
      "utf8",
    );
    writeFileSync(
      join(workspace, "data", "textmap", "TextMapEN.json"),
      JSON.stringify({ "100": "The Herta", "200": "The Herta's experiment" }),
      "utf8",
    );
    const logs: string[] = [];
    const code = await runKnowledgeCli(["glossary", "大黑塔", "--limit", "1"], {
      cwd: workspace,
      log: (l) => logs.push(l),
      err: (l) => logs.push(l),
    });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("CN: 大黑塔");
    expect(out).toContain("EN: The Herta");
    expect(out).toContain("[100]"); // shortest hit first, limited to 1
    expect(out).not.toContain("[200]");
  });

  it("glossary fails with guidance when the TextMaps are absent", async () => {
    const logs: string[] = [];
    const code = await runKnowledgeCli(["glossary", "黑塔"], {
      cwd: workspace,
      log: (l) => logs.push(l),
      err: (l) => logs.push(l),
    });
    expect(code).toBe(2);
    expect(logs.join("\n")).toMatch(/TextMapCHS\.json/);
  });

  it("ingests when given `ingest --data-root ./data`", async () => {
    const logs: string[] = [];
    const code = await runKnowledgeCli(
      ["ingest", "--data-root", "./data", "--force"],
      {
        cwd: workspace,
        log: (l) => logs.push(l),
        err: (l) => logs.push(l),
      },
    );
    expect(code).toBe(0);
    expect(
      existsSync(join(workspace, ".herta/knowledge/herta-canon.sqlite")),
    ).toBe(true);
    expect(logs.join("\n")).toMatch(/files/i);
  });

  it("rejects --deepseek required when no API key is available", async () => {
    delete process.env.HERTA_DEEPSEEK_API_KEY;
    const logs: string[] = [];
    const code = await runKnowledgeCli(
      ["ingest", "--data-root", "./data", "--deepseek", "required"],
      {
        cwd: workspace,
        log: (l) => logs.push(l),
        err: (l) => logs.push(l),
      },
    );
    expect(code).toBe(3);
    expect(logs.join("\n")).toMatch(/api key|deepseek key/i);
  });

  it("logs the claims count by default", async () => {
    const logs: string[] = [];
    const code = await runKnowledgeCli(
      ["ingest", "--data-root", "./data", "--force"],
      {
        cwd: workspace,
        log: (l) => logs.push(l),
        err: (l) => logs.push(l),
      },
    );
    expect(code).toBe(0);
    expect(logs.some((l) => /claims:\s*\d+/.test(l))).toBe(true);
  });

  it("accepts --no-claims and reports 0", async () => {
    const logs: string[] = [];
    const code = await runKnowledgeCli(
      ["ingest", "--data-root", "./data", "--force", "--no-claims"],
      {
        cwd: workspace,
        log: (l) => logs.push(l),
        err: (l) => logs.push(l),
      },
    );
    expect(code).toBe(0);
    expect(logs.some((l) => /claims:\s*0\b/.test(l))).toBe(true);
  });

  it("accepts --deepseek auto and continues without key (warning logged)", async () => {
    delete process.env.HERTA_DEEPSEEK_API_KEY;
    const logs: string[] = [];
    const code = await runKnowledgeCli(
      ["ingest", "--data-root", "./data", "--deepseek", "auto", "--force"],
      {
        cwd: workspace,
        log: (l) => logs.push(l),
        err: (l) => logs.push(l),
      },
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(
      /deepseek key.*missing|no.*api key|deterministic-only/i,
    );
  });

  it("rejects --llm-claims required when no API key is available", async () => {
    delete process.env.HERTA_DEEPSEEK_API_KEY;
    const logs: string[] = [];
    const code = await runKnowledgeCli(
      [
        "ingest",
        "--data-root",
        "./data",
        "--llm-claims",
        "required",
        "--deepseek",
        "off",
      ],
      {
        cwd: workspace,
        log: (l) => logs.push(l),
        err: (l) => logs.push(l),
      },
    );
    expect(code).toBe(3);
    expect(logs.join("\n")).toMatch(/llm.?claims.*api key|deepseek key/i);
  });

  it("logs llm_claims summary line as 'skipped' when --llm-claims off", async () => {
    const logs: string[] = [];
    const code = await runKnowledgeCli(
      ["ingest", "--data-root", "./data", "--force", "--llm-claims", "off"],
      {
        cwd: workspace,
        log: (l) => logs.push(l),
        err: (l) => logs.push(l),
      },
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/llm_claims:\s*skipped/);
  });

  it("logs the wiki count by default", async () => {
    const logs: string[] = [];
    const code = await runKnowledgeCli(
      ["ingest", "--data-root", "./data", "--force"],
      {
        cwd: workspace,
        log: (l) => logs.push(l),
        err: (l) => logs.push(l),
      },
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/wiki:\s*\d+/);
  });

  it("accepts --no-wiki and reports wiki: 0", async () => {
    const logs: string[] = [];
    const code = await runKnowledgeCli(
      ["ingest", "--data-root", "./data", "--force", "--no-wiki"],
      {
        cwd: workspace,
        log: (l) => logs.push(l),
        err: (l) => logs.push(l),
      },
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/wiki:\s*0\b/);
  });
});

describe("runKnowledgeCli — voice-stratify", () => {
  it("calls runStratifyPass with default speaker and prints the summary line", async () => {
    const stratify = vi.fn().mockResolvedValue({
      chunksClassified: 1247,
      byClass: {
        player: 89,
        other_named: 234,
        self_narration: 12,
        unknown: 912,
      },
    });
    const deps: CliDeps = { runStratifyPass: stratify };
    const logs: string[] = [];
    const errs: string[] = [];
    const code = await runKnowledgeCli(
      ["voice-stratify"],
      {
        cwd: workspace,
        log: (l) => logs.push(l),
        err: (l) => errs.push(l),
      },
      deps,
    );
    expect(code).toBe(0);
    expect(stratify).toHaveBeenCalledTimes(1);
    const arg = stratify.mock.calls[0]?.[0] as { speakerEntityId?: string };
    expect(arg?.speakerEntityId).toBe("herta.person.prime");
    expect(logs.join("\n")).toContain(
      "voice-stratify: classified 1247 chunks (player=89, other_named=234, self_narration=12, unknown=912)",
    );
  });

  it("respects --speaker", async () => {
    const stratify = vi.fn().mockResolvedValue({
      chunksClassified: 0,
      byClass: { player: 0, other_named: 0, self_narration: 0, unknown: 0 },
    });
    const deps: CliDeps = { runStratifyPass: stratify };
    const code = await runKnowledgeCli(
      ["voice-stratify", "--speaker", "person.screwllum"],
      {
        cwd: workspace,
        log: () => {},
        err: () => {},
      },
      deps,
    );
    expect(code).toBe(0);
    const arg = stratify.mock.calls[0]?.[0] as { speakerEntityId?: string };
    expect(arg?.speakerEntityId).toBe("person.screwllum");
  });

  it("rejects unknown options", async () => {
    const errs: string[] = [];
    const code = await runKnowledgeCli(
      ["voice-stratify", "--bogus"],
      {
        cwd: workspace,
        log: () => {},
        err: (l) => errs.push(l),
      },
      { runStratifyPass: vi.fn() },
    );
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/unknown option/);
  });
});

describe("runKnowledgeCli — voice-restratify-llm", () => {
  it("--dry-run produces no DB writes and prints estimate", async () => {
    const dbPath = join(
      tmpdir(),
      `herta-restrat-dry-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    const store = SqliteKnowledgeStore.openOrCreate({ dbPath });
    store.upsertDocument({
      id: "doc1",
      kind: "mission_dialogue",
      title: "test",
      path: "/nonexistent/scene.html",
      sourceHash: "h1",
      createdAt: "2026-05-09T00:00:00Z",
    });
    store.upsertChunk({
      id: "doc1#1",
      documentId: "doc1",
      ordinal: 1,
      sectionPath: [],
      speaker: "黑塔",
      speakerEntityId: HERTA_PERSON_PRIME,
      authorEntityId: undefined,
      text: "test",
      textHash: "th1",
      tokenEstimate: 5,
      isDialogue: true,
      isHertaVoiceEvidence: true,
      isCanonFactCandidate: false,
      qualityScore: 1.0,
    });
    store.upsertEntity({
      id: HERTA_PERSON_PRIME,
      kind: "person",
      canonicalName: "Herta",
      aliases: ["黑塔"],
    });
    store.close();

    const logs: string[] = [];
    const errs: string[] = [];
    const restratify = vi.fn().mockResolvedValue({
      docsProcessed: 0,
      chunksWithConsensus: 0,
      chunksWithDisagreement: 0,
      disagreementWithHeuristic: 0,
      disagreementRate: 0,
      aborted: false,
      estimatedCalls: 2,
    });
    const deps: CliDeps = { runRestratifyLlmPass: restratify };
    const exit = await runKnowledgeCli(
      [
        "voice-restratify-llm",
        "--db",
        dbPath,
        "--speaker",
        HERTA_PERSON_PRIME,
        "--dry-run",
      ],
      { cwd: workspace, log: (l) => logs.push(l), err: (l) => errs.push(l) },
      deps,
    );
    expect(exit).toBe(0);
    const output = [...logs, ...errs].join("\n");
    expect(output).toMatch(/dry.?run|estimate/i);
    // runRestratifyLlmPass should have been called with dryRun: true
    expect(restratify).toHaveBeenCalledTimes(1);
    const arg = restratify.mock.calls[0]?.[0] as { dryRun?: boolean };
    expect(arg?.dryRun).toBe(true);

    rmSync(dbPath, { force: true });
  });

  it("refuses to start when --budget-cap-usd is below estimate", async () => {
    const dbPath = join(
      tmpdir(),
      `herta-restrat-budget-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    const store = SqliteKnowledgeStore.openOrCreate({ dbPath });
    store.upsertEntity({
      id: HERTA_PERSON_PRIME,
      kind: "person",
      canonicalName: "Herta",
      aliases: [],
    });
    for (let i = 0; i < 5; i++) {
      store.upsertDocument({
        id: `doc${i}`,
        kind: "mission_dialogue",
        title: `t${i}`,
        path: `/nonexistent/s${i}.html`,
        sourceHash: `h${i}`,
        createdAt: "2026-05-09T00:00:00Z",
      });
      store.upsertChunk({
        id: `doc${i}#1`,
        documentId: `doc${i}`,
        ordinal: 1,
        sectionPath: [],
        speaker: "黑塔",
        speakerEntityId: HERTA_PERSON_PRIME,
        authorEntityId: undefined,
        text: "x",
        textHash: `t${i}`,
        tokenEstimate: 5,
        isDialogue: true,
        isHertaVoiceEvidence: true,
        isCanonFactCandidate: false,
        qualityScore: 1.0,
      });
    }
    store.close();

    const logs: string[] = [];
    const errs: string[] = [];
    const exit = await runKnowledgeCli(
      ["voice-restratify-llm", "--db", dbPath, "--budget-cap-usd", "0.001"],
      { cwd: workspace, log: (l) => logs.push(l), err: (l) => errs.push(l) },
      {},
    );
    expect(exit).not.toBe(0);
    const errOutput = errs.join("\n");
    expect(errOutput).toMatch(/budget|cap/i);

    rmSync(dbPath, { force: true });
  });
});

// ---------------------------------------------------------------------------
// shared capture helper for the subcommand tests below
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function mkCapturingIo(cwd: string): {
  io: import("./herta-knowledge.js").CliIo;
  logs: string[];
  errs: string[];
} {
  const logs: string[] = [];
  const errs: string[] = [];
  return {
    io: {
      cwd,
      log: (l: string) => logs.push(l),
      err: (l: string) => errs.push(l),
    },
    logs,
    errs,
  };
}

// ---------------------------------------------------------------------------
// persona-seed
// ---------------------------------------------------------------------------

describe("runKnowledgeCli — persona-seed", () => {
  it("--dry-run prints estimate without writing", async () => {
    const h = mkTempKnowledgeDb();
    h.store.upsertEntity({
      id: "herta.person.prime",
      kind: "person",
      canonicalName: "Herta",
      aliases: [],
    });
    const tmpPersona = fs.mkdtempSync(path.join(os.tmpdir(), "persona-seed-"));
    const { io, logs } = mkCapturingIo(workspace);
    const exit = await runKnowledgeCli(
      [
        "persona-seed",
        "--db",
        h.dbPath,
        "--persona-dir",
        tmpPersona,
        "--component",
        "wardrobe",
        "--dry-run",
      ],
      io,
    );
    expect(exit).toBe(0);
    expect(fs.existsSync(path.join(tmpPersona, "wardrobe.json"))).toBe(false);
    expect(logs.join("\n")).toMatch(/dry.?run/i);
    fs.rmSync(tmpPersona, { recursive: true, force: true });
    h.cleanup();
  });

  it("rejects unknown --component", async () => {
    const h = mkTempKnowledgeDb();
    const { io } = mkCapturingIo(workspace);
    const exit = await runKnowledgeCli(
      ["persona-seed", "--db", h.dbPath, "--component", "no_such_thing"],
      io,
    );
    expect(exit).toBe(2);
    h.cleanup();
  });
});

// ---------------------------------------------------------------------------
// self-model ship (Phase 6)
// ---------------------------------------------------------------------------

describe("runKnowledgeCli — self-model ship", () => {
  function writeMinimalSelfModel(workspaceDir: string): string {
    const dir = path.join(workspaceDir, ".herta", "self-model");
    fs.mkdirSync(dir, { recursive: true });
    const selfModelPath = path.join(dir, "herta_self_model_v1.json");
    fs.writeFileSync(
      selfModelPath,
      JSON.stringify({
        version: 1,
        generated_at: "2026-05-11T00:00:00.000Z",
        provenance: {
          passes: [
            { name: "fact-extract", model: "deepseek-v4-pro" },
            { name: "synthesize", model: "deepseek-v4-pro" },
          ],
        },
        biography: {
          prose: "我是黑塔本人，天才俱乐部 #83。",
          key_facts: [
            { fact: "Genius Society #83", evidence: ["078_黑塔.html"] },
          ],
        },
        philosophy: { prose: "我看重效率。", key_facts: [] },
        embodiment: { prose: "我的工坊在空间站。", key_facts: [] },
        relationships: {},
        harness_proprioception: {
          prose: "终端是我桌上的一根线，我亲自打字。",
          key_facts: [],
        },
        anti_patterns: [],
        interaction_register: {
          prose: "对小事直接，对难题靠近。",
          samples: [],
        },
      }),
      "utf8",
    );
    return selfModelPath;
  }

  it("ships a self-model into self_models table when Pass 3a passes", async () => {
    const h = mkTempKnowledgeDb();
    writeMinimalSelfModel(workspace);

    const { io, logs } = mkCapturingIo(workspace);
    const exit = await runKnowledgeCli(
      ["self-model", "ship", "--db", h.dbPath],
      io,
    );
    expect(exit).toBe(0);
    expect(logs.join("\n")).toMatch(/PASSED/);
    expect(logs.join("\n")).toMatch(/shipped row/);

    // Re-open the DB and confirm the row landed.
    const store = SqliteKnowledgeStore.openOrCreate({ dbPath: h.dbPath });
    try {
      const row = store.getLatestSelfModel(HERTA_PERSON_PRIME);
      expect(row).toBeDefined();
      expect(row?.schemaVersion).toBe(1);
      const payload = JSON.parse(row!.payloadJson) as {
        biography: { prose: string };
      };
      expect(payload.biography.prose).toMatch(/天才俱乐部/);
    } finally {
      store.close();
    }
    h.cleanup();
  });

  it("aborts when Pass 3a fails (banned phrase)", async () => {
    const h = mkTempKnowledgeDb();
    const dir = path.join(workspace, ".herta", "self-model");
    fs.mkdirSync(dir, { recursive: true });
    const selfModelPath = path.join(dir, "herta_self_model_v1.json");
    fs.writeFileSync(
      selfModelPath,
      JSON.stringify({
        version: 1,
        generated_at: "2026-05-11T00:00:00.000Z",
        provenance: {
          passes: [
            { name: "fact-extract", model: "deepseek-v4-pro" },
            { name: "synthesize", model: "deepseek-v4-pro" },
          ],
        },
        biography: { prose: "我是 Herta CLI 这个文字通道。", key_facts: [] },
        philosophy: { prose: "x", key_facts: [] },
        embodiment: { prose: "x", key_facts: [] },
        relationships: {},
        harness_proprioception: { prose: "x", key_facts: [] },
        anti_patterns: [],
        interaction_register: { prose: "x", samples: [] },
      }),
      "utf8",
    );

    const { io, errs } = mkCapturingIo(workspace);
    const exit = await runKnowledgeCli(
      ["self-model", "ship", "--db", h.dbPath],
      io,
    );
    expect(exit).toBe(1);
    expect(errs.join("\n")).toMatch(/FAILED|aborted/);

    // No row should have been inserted.
    const store = SqliteKnowledgeStore.openOrCreate({ dbPath: h.dbPath });
    try {
      expect(store.getLatestSelfModel(HERTA_PERSON_PRIME)).toBeUndefined();
    } finally {
      store.close();
    }
    h.cleanup();
  });

  it("--dry-run does not insert a row", async () => {
    const h = mkTempKnowledgeDb();
    writeMinimalSelfModel(workspace);

    const { io, logs } = mkCapturingIo(workspace);
    const exit = await runKnowledgeCli(
      ["self-model", "ship", "--db", h.dbPath, "--dry-run"],
      io,
    );
    expect(exit).toBe(0);
    expect(logs.join("\n")).toMatch(/dry-run/);

    const store = SqliteKnowledgeStore.openOrCreate({ dbPath: h.dbPath });
    try {
      expect(store.getLatestSelfModel(HERTA_PERSON_PRIME)).toBeUndefined();
    } finally {
      store.close();
    }
    h.cleanup();
  });

  it("skips re-ship when source_facts_hash matches latest row (no --force)", async () => {
    const h = mkTempKnowledgeDb();
    writeMinimalSelfModel(workspace);
    // Also write a facts file so source_facts_hash is non-null.
    const factsPath = path.join(
      workspace,
      ".herta",
      "self-model",
      "herta_facts.json",
    );
    fs.writeFileSync(
      factsPath,
      JSON.stringify({ version: 1, files: [], failures: [] }),
      "utf8",
    );

    // First ship — should succeed.
    const io1 = mkCapturingIo(workspace);
    const exit1 = await runKnowledgeCli(
      ["self-model", "ship", "--db", h.dbPath],
      io1.io,
    );
    expect(exit1).toBe(0);
    expect(io1.logs.join("\n")).toMatch(/shipped row/);

    // Second ship without --force — should skip.
    const io2 = mkCapturingIo(workspace);
    const exit2 = await runKnowledgeCli(
      ["self-model", "ship", "--db", h.dbPath],
      io2.io,
    );
    expect(exit2).toBe(0);
    expect(io2.logs.join("\n")).toMatch(
      /no change since|same source_facts_hash/,
    );
    expect(io2.logs.join("\n")).not.toMatch(/shipped row/);

    // Confirm only one row exists.
    const store = SqliteKnowledgeStore.openOrCreate({ dbPath: h.dbPath });
    try {
      const history = store.listSelfModelHistory(HERTA_PERSON_PRIME);
      expect(history).toHaveLength(1);
    } finally {
      store.close();
    }
    h.cleanup();
  });

  it("--force re-ships even when hash matches", async () => {
    const h = mkTempKnowledgeDb();
    writeMinimalSelfModel(workspace);
    const factsPath = path.join(
      workspace,
      ".herta",
      "self-model",
      "herta_facts.json",
    );
    fs.writeFileSync(
      factsPath,
      JSON.stringify({ version: 1, files: [], failures: [] }),
      "utf8",
    );

    await runKnowledgeCli(
      ["self-model", "ship", "--db", h.dbPath],
      mkCapturingIo(workspace).io,
    );
    const io2 = mkCapturingIo(workspace);
    const exit2 = await runKnowledgeCli(
      ["self-model", "ship", "--db", h.dbPath, "--force"],
      io2.io,
    );
    expect(exit2).toBe(0);
    expect(io2.logs.join("\n")).toMatch(/shipped row/);

    const store = SqliteKnowledgeStore.openOrCreate({ dbPath: h.dbPath });
    try {
      expect(store.listSelfModelHistory(HERTA_PERSON_PRIME)).toHaveLength(2);
    } finally {
      store.close();
    }
    h.cleanup();
  });
});
