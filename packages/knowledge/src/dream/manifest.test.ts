import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDreamConfig } from "./config.js";
import {
  emptyManifest,
  isEpisodeDreamed,
  liveDreamRecords,
  pickEvictionTarget,
  readManifest,
  reinforceRecord,
  staleLiveRecords,
  weakestByRetention,
  weakestLiveRecord,
  writeManifest,
} from "./manifest.js";
import type { DreamCreatedRecord } from "./types.js";

const rec = (
  id: string,
  voice: number,
  generatedAt: string,
  extra: Partial<DreamCreatedRecord> = {},
): DreamCreatedRecord => ({
  id,
  file: `### 废案_0${id}：t.txt`,
  nn: Number(id),
  state: "live",
  sourceSessionId: "s",
  sourceEpisodeHash: `h${id}`,
  sourceEpisodes: [`h${id}`],
  runId: "r",
  model: "deepseek-v4-pro",
  generatedAt,
  situationTag: "tag",
  summary: "这是一段叙事开篇摘要。",
  critiqueScores: { voice, format: 1, novelty: 1 },
  validateFeianPassed: true,
  reactivationCount: 0,
  ...extra,
});

describe("manifest", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dream-mf-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips through disk; missing file → empty", () => {
    expect(readManifest(dir)).toEqual(emptyManifest());
    const m = emptyManifest();
    m.episodes.push({
      sessionId: "s",
      episodeHash: "h1",
      outcome: "skipped",
      timestamp: "t",
    });
    writeManifest(dir, m);
    expect(readManifest(dir).episodes).toHaveLength(1);
  });

  it("isEpisodeDreamed matches on sessionId + episodeHash", () => {
    const m = emptyManifest();
    m.episodes.push({
      sessionId: "s",
      episodeHash: "h1",
      outcome: "promoted",
      timestamp: "t",
    });
    expect(isEpisodeDreamed(m, "s", "h1")).toBe(true);
    expect(isEpisodeDreamed(m, "s", "h2")).toBe(false);
  });

  it("liveDreamRecords filters out archived; weakest = lowest voice, tiebreak oldest", () => {
    const m = emptyManifest();
    m.created.push(rec("1", 0.9, "2026-06-18T09:00:00Z"));
    m.created.push(rec("2", 0.7, "2026-06-18T10:00:00Z"));
    m.created.push({
      ...rec("3", 0.5, "2026-06-18T11:00:00Z"),
      state: "archived",
    });
    expect(liveDreamRecords(m)).toHaveLength(2);
    expect(weakestLiveRecord(m)?.id).toBe("2"); // 0.7 is the lowest LIVE voice
  });

  it("weakestLiveRecord breaks an equal-voice tie by oldest generatedAt", () => {
    const m = emptyManifest();
    m.created.push(rec("A", 0.7, "2026-06-18T11:00:00Z")); // newer
    m.created.push(rec("B", 0.7, "2026-06-18T09:00:00Z")); // older → weakest
    expect(weakestLiveRecord(m)?.id).toBe("B");
  });

  it("weakestLiveRecord returns undefined when no live records exist", () => {
    const m = emptyManifest();
    m.created.push({
      ...rec("1", 0.9, "2026-06-18T09:00:00Z"),
      state: "archived",
    });
    expect(weakestLiveRecord(m)).toBeUndefined();
  });

  it("readManifest returns empty on a corrupt JSON file", () => {
    writeFileSync(join(dir, "manifest.json"), "{ bad json", "utf8");
    expect(readManifest(dir)).toEqual(emptyManifest());
  });

  it("writeManifest creates a missing nested dir; lastRunAt round-trips", () => {
    const subdir = join(dir, "nested", "dream");
    const m = emptyManifest();
    m.lastRunAt = "2026-06-18T09:00:00Z";
    writeManifest(subdir, m);
    const back = readManifest(subdir);
    expect(back).toEqual(m);
    expect(back.lastRunAt).toBe("2026-06-18T09:00:00Z");
  });

  it("writeManifest is atomic: round-trips and leaves no temp residue", () => {
    const m = emptyManifest();
    m.lastRunAt = "2026-06-18T09:00:00Z";
    writeManifest(dir, m);
    expect(readManifest(dir)).toEqual(m);
    // The temp file is renamed over the target, never left behind.
    expect(readdirSync(dir)).toEqual(["manifest.json"]);
  });

  it("readManifest back-fills reactivationCount and sourceEpisodes for legacy records", () => {
    // A record written before slice 1 lacks both fields.
    const legacy = {
      version: 1,
      episodes: [],
      created: [
        {
          id: "1",
          file: "### 废案_01：t.txt",
          nn: 1,
          state: "live",
          sourceSessionId: "s",
          sourceEpisodeHash: "hLegacy",
          runId: "r",
          model: "m",
          generatedAt: "2026-06-18T09:00:00Z",
          situationTag: "tag",
          summary: "摘要",
          critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
          validateFeianPassed: true,
          estimatedPrefixTokens: 100,
        },
      ],
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(legacy), "utf8");
    const back = readManifest(dir);
    const r = back.created[0];
    expect(r?.reactivationCount).toBe(0);
    expect(r?.sourceEpisodes).toEqual(["hLegacy"]);
    // ADR 0021: `occasion` is additive/optional — a legacy record loads
    // unchanged with the field simply absent (no schema version bump).
    expect(r?.occasion).toBeUndefined();
    expect(back.version).toBe(1);
  });

  it("a record written before 2026-09-23 sheds `estimatedPrefixTokens` — a char count nothing read (ADR 0069 §12)", () => {
    const legacy = {
      version: 1,
      episodes: [],
      created: [
        {
          ...rec("1", 0.9, "2026-07-01T00:00:00Z", { gistFolded: true }),
          estimatedPrefixTokens: 4796,
        },
      ],
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(legacy), "utf8");
    const back = readManifest(dir);
    expect(back.created[0]).toEqual(
      rec("1", 0.9, "2026-07-01T00:00:00Z", { gistFolded: true }),
    );
    // The next write, whatever the pass changed, leaves it out of the file.
    writeManifest(dir, back);
    expect(readFileSync(join(dir, "manifest.json"), "utf8")).not.toContain(
      "estimatedPrefixTokens",
    );
  });

  it("round-trips a record's occasion field (ADR 0021, additive)", () => {
    const m = emptyManifest();
    m.created.push(
      rec("1", 0.9, "2026-07-01T00:00:00Z", {
        occasion: "开拓者讲述了那次 force push 事故。",
      }),
    );
    writeManifest(dir, m);
    expect(readManifest(dir).created[0]?.occasion).toBe(
      "开拓者讲述了那次 force push 事故。",
    );
  });

  it("weakestByRetention can rank a high-voice-but-stale dream below a fresh lower-voice one", () => {
    const cfg = resolveDreamConfig({
      retentionHalfLifeDays: 30,
      retentionReactivationK: 0.5,
    });
    const now = Date.parse("2026-07-01T00:00:00Z");
    const m = emptyManifest();
    // High voice (0.95) but 120 days stale → heavily decayed.
    m.created.push(rec("stale", 0.95, "2026-03-03T00:00:00Z"));
    // Lower voice (0.82) but freshly generated → barely decayed.
    m.created.push(rec("fresh", 0.82, "2026-07-01T00:00:00Z"));
    // Voice-only ranking would pick "fresh" (0.82 < 0.95); retention flips it.
    expect(weakestLiveRecord(m)?.id).toBe("fresh");
    expect(weakestByRetention(m, now, cfg)?.id).toBe("stale");
  });

  it("weakestByRetention breaks a strength tie by oldest generatedAt", () => {
    const cfg = resolveDreamConfig();
    const now = Date.parse("2026-07-01T00:00:00Z");
    const m = emptyManifest();
    // Same voice, same reactivation, same last-activity anchor → equal strength.
    m.created.push(rec("A", 0.8, "2026-06-30T00:00:00Z"));
    m.created.push(rec("B", 0.8, "2026-06-20T00:00:00Z")); // older
    expect(weakestByRetention(m, now, cfg)?.id).toBe("B");
  });

  it("reactivationCount raises retention, protecting a reactivated dream from eviction", () => {
    const cfg = resolveDreamConfig({ retentionHalfLifeDays: 30 });
    const now = Date.parse("2026-07-01T00:00:00Z");
    const m = emptyManifest();
    // Both same voice + same age, but one has been reactivated (and its clock
    // reset). The un-reactivated one is the weaker → the eviction target.
    m.created.push(
      rec("hot", 0.8, "2026-05-01T00:00:00Z", {
        reactivationCount: 3,
        lastReactivatedAt: "2026-06-28T00:00:00Z",
      }),
    );
    m.created.push(rec("cold", 0.8, "2026-05-01T00:00:00Z"));
    expect(weakestByRetention(m, now, cfg)?.id).toBe("cold");
  });

  it("staleLiveRecords is empty at floor 0 and returns decayed records above it", () => {
    const now = Date.parse("2026-07-01T00:00:00Z");
    const m = emptyManifest();
    m.created.push(rec("old", 0.9, "2026-01-01T00:00:00Z")); // very stale
    m.created.push(rec("new", 0.9, "2026-07-01T00:00:00Z")); // fresh
    // Floor 0 → disabled, nothing stale.
    expect(
      staleLiveRecords(m, now, resolveDreamConfig({ retentionFloor: 0 })),
    ).toHaveLength(0);
    // With a floor + short half-life, the very stale one drops below it; the
    // fresh one (strength ≈ 0.9) stays above.
    const stale = staleLiveRecords(
      m,
      now,
      resolveDreamConfig({ retentionFloor: 0.5, retentionHalfLifeDays: 30 }),
    );
    expect(stale.map((r) => r.id)).toEqual(["old"]);
  });
});

describe("reinforceRecord spacing guard (ADR 0022)", () => {
  it("a repeat WITHIN the window is a retention no-op, marked spaced", () => {
    const m = emptyManifest();
    m.created.push(
      rec("1", 0.9, "2026-07-01T00:00:00Z", {
        reactivationCount: 2,
        lastReactivatedAt: "2026-07-10T08:00:00Z",
      }),
    );
    const r = reinforceRecord(
      m,
      "1",
      "2026-07-10T20:00:00Z", // 12h later — inside the 24h window
      24 * 60 * 60_000,
    );
    expect(r?.spaced).toBe(true);
    expect(r?.record.reactivationCount).toBe(2); // no bump
    expect(r?.record.lastReactivatedAt).toBe("2026-07-10T08:00:00Z"); // no reset
  });

  it("a repeat BEYOND the window bumps and resets the clock", () => {
    const m = emptyManifest();
    m.created.push(
      rec("1", 0.9, "2026-07-01T00:00:00Z", {
        reactivationCount: 2,
        lastReactivatedAt: "2026-07-08T08:00:00Z",
      }),
    );
    const r = reinforceRecord(m, "1", "2026-07-10T20:00:00Z", 24 * 60 * 60_000);
    expect(r?.spaced).toBe(false);
    expect(r?.record.reactivationCount).toBe(3);
    expect(r?.record.lastReactivatedAt).toBe("2026-07-10T20:00:00Z");
  });

  it("a never-reactivated record anchors the window on its birth", () => {
    const m = emptyManifest();
    m.created.push(rec("1", 0.9, "2026-07-10T08:00:00Z"));
    const spaced = reinforceRecord(
      m,
      "1",
      "2026-07-10T12:00:00Z",
      24 * 60 * 60_000,
    );
    expect(spaced?.spaced).toBe(true);
  });

  it("spacingMs 0 (disabled / legacy callers) always bumps", () => {
    const m = emptyManifest();
    m.created.push(
      rec("1", 0.9, "2026-07-10T08:00:00Z", {
        lastReactivatedAt: "2026-07-10T11:00:00Z",
      }),
    );
    const r = reinforceRecord(m, "1", "2026-07-10T12:00:00Z");
    expect(r?.spaced).toBe(false);
    expect(r?.record.reactivationCount).toBe(1);
  });
});

describe("pickEvictionTarget — interference-aware (ADR 0022)", () => {
  const cfg = resolveDreamConfig();
  const now = Date.parse("2026-07-10T00:00:00Z");

  it("evicts the weakest WITHIN duplicated situationTags, sparing a weaker unique-tag record", () => {
    const m = emptyManifest();
    // Unique tag, WEAKEST overall (old + low voice) — must survive.
    m.created.push(
      rec("1", 0.8, "2026-01-01T00:00:00Z", { situationTag: "unique-lesson" }),
    );
    // Two records sharing a tag — redundancy: the weaker of THESE goes.
    m.created.push(
      rec("2", 0.85, "2026-06-01T00:00:00Z", { situationTag: "dry-refusal" }),
    );
    m.created.push(
      rec("3", 0.95, "2026-07-01T00:00:00Z", { situationTag: "dry-refusal" }),
    );
    expect(pickEvictionTarget(m, now, cfg)?.id).toBe("2");
    // Sanity: the globally weakest is the unique one — the old rule would
    // have evicted the corpus's only copy of that register situation.
    expect(weakestByRetention(m, now, cfg)?.id).toBe("1");
  });

  it("falls back to the globally weakest when every live tag is unique", () => {
    const m = emptyManifest();
    m.created.push(
      rec("1", 0.8, "2026-01-01T00:00:00Z", { situationTag: "a" }),
    );
    m.created.push(
      rec("2", 0.95, "2026-07-01T00:00:00Z", { situationTag: "b" }),
    );
    expect(pickEvictionTarget(m, now, cfg)?.id).toBe("1");
  });

  it("ignores archived records when counting tag redundancy", () => {
    const m = emptyManifest();
    m.created.push(
      rec("1", 0.8, "2026-01-01T00:00:00Z", { situationTag: "a" }),
    );
    m.created.push(
      rec("2", 0.95, "2026-07-01T00:00:00Z", {
        situationTag: "a",
        state: "archived",
      }),
    );
    m.created.push(
      rec("3", 0.9, "2026-06-01T00:00:00Z", { situationTag: "b" }),
    );
    // Tag "a" is only duplicated across live+archived — not real redundancy.
    expect(pickEvictionTarget(m, now, cfg)?.id).toBe("1");
  });
});
