import type { TerminalRecordBlock } from "@herta/core";
import { describe, expect, it } from "vitest";
import { emptyManifest } from "./manifest.js";
import { selectPromptExclusions } from "./prompt-exclusions.js";
import { segmentSession } from "./segment-session.js";
import type { DreamCreatedRecord, DreamManifest } from "./types.js";

const u = (text: string, at?: string): TerminalRecordBlock => ({
  kind: "user",
  text,
  ...(at ? { at } : {}),
});
const h = (text: string, at?: string): TerminalRecordBlock => ({
  kind: "herta",
  surface: "speech",
  text,
  ...(at ? { at } : {}),
});

const OPTS = {
  episodeGapMs: 20 * 60_000,
  maxEpisodeBlocks: 60,
  maxEpisodeMs: 45 * 60_000,
};

const mkCreated = (
  id: string,
  sourceEpisodes: readonly string[],
  extra: Partial<DreamCreatedRecord> = {},
): DreamCreatedRecord => ({
  id,
  file: `### 废案_0${id}：t.txt`,
  nn: Number(id),
  state: "live",
  sourceSessionId: "s1",
  sourceEpisodeHash: sourceEpisodes[0] ?? "h0",
  sourceEpisodes,
  runId: "r",
  model: "deepseek-v4-pro",
  generatedAt: "2026-06-18T09:00:00Z",
  situationTag: "tag",
  summary: "这是一段叙事开篇摘要。",
  critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
  validateFeianPassed: true,
  reactivationCount: 0,
  ...extra,
});

const withCreated = (...created: DreamCreatedRecord[]): DreamManifest => ({
  ...emptyManifest(),
  created,
});

/** The ledger rows a real pass writes: each source episode, by session. */
const withLedger = (
  m: DreamManifest,
  rows: ReadonlyArray<readonly [hash: string, sessionId: string]>,
): DreamManifest => ({
  ...m,
  episodes: rows.map(([episodeHash, sessionId]) => ({
    sessionId,
    episodeHash,
    outcome: "promoted",
    timestamp: "2026-06-18T12:00:00Z",
  })),
});

/** Two gap-separated episodes: ep1 = blocks [0,2), ep2 = blocks [2,4). */
const TWO_EPISODE_RECORD: TerminalRecordBlock[] = [
  u("topic A", "2026-06-18T09:00:00Z"),
  h("ans A", "2026-06-18T09:00:30Z"),
  u("topic B", "2026-06-18T11:00:00Z"), // +2h gap → boundary at index 2
  h("ans B", "2026-06-18T11:00:30Z"),
];

function hashesOf(record: readonly TerminalRecordBlock[]): string[] {
  return segmentSession("s1", record, OPTS).map((e) => e.episodeHash);
}

describe("selectPromptExclusions", () => {
  it("cuts the record the way the ledger was cut — the verdict cut from the manifest's cutover (ADR 0069 §4)", () => {
    const CUT = "2026-09-24T00:00:00.000Z";
    const at = (m: number): string =>
      new Date(Date.parse(CUT) + m * 60_000).toISOString();
    const record: TerminalRecordBlock[] = [
      u("fix the parser", at(1)),
      h("@板砖 修一下 parser", at(2)),
      {
        kind: "system",
        label: "差分协处理器",
        body: "完成",
        role: "done-marker",
        at: at(3),
      },
      h("修好了，定向测试过了。", at(4)),
      u("now the docs", at(5)),
      h("docs 我看看。", at(6)),
    ];
    // The pass dreamed the commission as the verdict cut makes it: [0, 4).
    const [commission] = segmentSession("s1", record, {
      ...OPTS,
      segmentationV2SinceMs: Date.parse(CUT),
    });
    expect(commission?.endIndex).toBe(4);
    const manifest: DreamManifest = {
      ...withLedger(
        withCreated(mkCreated("1", [commission?.episodeHash ?? ""])),
        [[commission?.episodeHash ?? "", "s1"]],
      ),
      segmentationV2Since: CUT,
    };
    // A fold put the commission behind the boundary: its 废案 is recovered
    // memory and loads. A filter cutting at the marker would not find the
    // hash, read it as withdrawn, and withhold it.
    const excluded = selectPromptExclusions({
      manifest,
      sessionId: "s1",
      record,
      recapBoundaryIndex: 4,
      config: OPTS,
    });
    expect(excluded.size).toBe(0);
  });

  it("excludes a 废案 whose source episode is verbatim (no recap engaged)", () => {
    const [ep1Hash] = hashesOf(TWO_EPISODE_RECORD);
    const rec = mkCreated("1", [ep1Hash ?? ""]);
    const excluded = selectPromptExclusions({
      manifest: withCreated(rec),
      sessionId: "s1",
      record: TWO_EPISODE_RECORD,
      recapBoundaryIndex: 0,
      config: OPTS,
    });
    expect(excluded).toEqual(new Set([rec.file]));
  });

  it("keeps a 废案 whose source episode fell behind the recap boundary", () => {
    const [ep1Hash, ep2Hash] = hashesOf(TWO_EPISODE_RECORD);
    const behind = mkCreated("1", [ep1Hash ?? ""]);
    const verbatim = mkCreated("2", [ep2Hash ?? ""]);
    // Boundary 2: ep1 ([0,2)) survives only via recap; ep2 ([2,4)) is verbatim.
    const excluded = selectPromptExclusions({
      manifest: withCreated(behind, verbatim),
      sessionId: "s1",
      record: TWO_EPISODE_RECORD,
      recapBoundaryIndex: 2,
      config: OPTS,
    });
    expect(excluded.has(behind.file)).toBe(false);
    expect(excluded).toEqual(new Set([verbatim.file]));
  });

  it("keeps a 废案 sourced from another session (no hash match)", () => {
    const rec = mkCreated("1", ["hash-from-elsewhere"], {
      sourceSessionId: "s-other",
    });
    const excluded = selectPromptExclusions({
      manifest: withCreated(rec),
      sessionId: "s1",
      record: TWO_EPISODE_RECORD,
      recapBoundaryIndex: 0,
      config: OPTS,
    });
    expect(excluded.size).toBe(0);
  });

  it("keeps a reconsolidated 废案 with any non-verbatim source episode", () => {
    const [ep1Hash] = hashesOf(TWO_EPISODE_RECORD);
    // Accreted across sessions: one source is verbatim here, one is foreign.
    const rec = mkCreated("1", [ep1Hash ?? "", "hash-from-elsewhere"]);
    const excluded = selectPromptExclusions({
      manifest: withCreated(rec),
      sessionId: "s1",
      record: TWO_EPISODE_RECORD,
      recapBoundaryIndex: 0,
      config: OPTS,
    });
    expect(excluded.size).toBe(0);
  });

  it("excludes a multi-source 废案 only when every source is verbatim", () => {
    const [ep1Hash, ep2Hash] = hashesOf(TWO_EPISODE_RECORD);
    const rec = mkCreated("1", [ep1Hash ?? "", ep2Hash ?? ""]);
    const manifest = withLedger(withCreated(rec), [
      [ep1Hash ?? "", "s1"],
      [ep2Hash ?? "", "s1"],
    ]);
    const boundary0 = selectPromptExclusions({
      manifest,
      sessionId: "s1",
      record: TWO_EPISODE_RECORD,
      recapBoundaryIndex: 0,
      config: OPTS,
    });
    expect(boundary0).toEqual(new Set([rec.file]));
    // Recap swallows ep1 → the record carries recovered detail again.
    const boundary2 = selectPromptExclusions({
      manifest,
      sessionId: "s1",
      record: TWO_EPISODE_RECORD,
      recapBoundaryIndex: 2,
      config: OPTS,
    });
    expect(boundary2.size).toBe(0);
  });

  it("fails CLOSED for the session's own episode that a rewind withdrew — the 废案 of what the user took back stays out (dream review 2026-09-22, finding 5)", () => {
    const [, ep2Hash] = hashesOf(TWO_EPISODE_RECORD);
    const rec = mkCreated("1", [ep2Hash ?? ""]);
    // The rewind truncated episode 2 away; the session reopens without it.
    const rewound = TWO_EPISODE_RECORD.slice(0, 2);
    const excluded = selectPromptExclusions({
      manifest: withLedger(withCreated(rec), [[ep2Hash ?? "", "s1"]]),
      sessionId: "s1",
      record: rewound,
      recapBoundaryIndex: 0,
      config: OPTS,
    });
    expect(excluded).toEqual(new Set([rec.file]));
  });

  it("fails closed too when a take-back REWROTE a block of the episode (the hash no longer matches)", () => {
    const [ep1Hash] = hashesOf(TWO_EPISODE_RECORD);
    const rec = mkCreated("1", [ep1Hash ?? ""]);
    const altered: TerminalRecordBlock[] = [
      u("topic A", "2026-06-18T09:00:00Z"),
      h("附件 spec.md · 已移除", "2026-06-18T09:00:30Z"),
      ...TWO_EPISODE_RECORD.slice(2),
    ];
    const excluded = selectPromptExclusions({
      manifest: withLedger(withCreated(rec), [[ep1Hash ?? "", "s1"]]),
      sessionId: "s1",
      record: altered,
      recapBoundaryIndex: 0,
      config: OPTS,
    });
    expect(excluded).toEqual(new Set([rec.file]));
  });

  it("another session's absent hash is never read as withdrawn", () => {
    const rec = mkCreated("1", ["hash-from-elsewhere"], {
      sourceSessionId: "s-other",
    });
    const excluded = selectPromptExclusions({
      manifest: withLedger(withCreated(rec), [
        ["hash-from-elsewhere", "s-other"],
      ]),
      sessionId: "s1",
      record: TWO_EPISODE_RECORD,
      recapBoundaryIndex: 0,
      config: OPTS,
    });
    expect(excluded.size).toBe(0);
  });

  it("never considers archived records", () => {
    const [ep1Hash] = hashesOf(TWO_EPISODE_RECORD);
    const rec = mkCreated("1", [ep1Hash ?? ""], { state: "archived" });
    const excluded = selectPromptExclusions({
      manifest: withCreated(rec),
      sessionId: "s1",
      record: TWO_EPISODE_RECORD,
      recapBoundaryIndex: 0,
      config: OPTS,
    });
    expect(excluded.size).toBe(0);
  });

  it("returns an empty set for an empty manifest or an empty record", () => {
    expect(
      selectPromptExclusions({
        manifest: emptyManifest(),
        sessionId: "s1",
        record: TWO_EPISODE_RECORD,
        recapBoundaryIndex: 0,
        config: OPTS,
      }).size,
    ).toBe(0);
    expect(
      selectPromptExclusions({
        manifest: withCreated(mkCreated("1", ["h1"])),
        sessionId: "s1",
        record: [],
        recapBoundaryIndex: 0,
        config: OPTS,
      }).size,
    ).toBe(0);
  });
});
