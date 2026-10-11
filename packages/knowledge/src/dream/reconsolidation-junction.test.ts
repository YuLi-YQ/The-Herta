import { describe, expect, it } from "vitest";
import { emptyManifest } from "./manifest.js";
import { findLiveById } from "./reconsolidation-junction.js";
import type { DreamCreatedRecord } from "./types.js";

const rec = (
  id: string,
  state: "live" | "archived",
  extra: Partial<DreamCreatedRecord> = {},
): DreamCreatedRecord => ({
  id,
  file: `### 废案_01：${id}.txt`,
  nn: 1,
  state,
  sourceSessionId: "s",
  sourceEpisodeHash: `h-${id}`,
  sourceEpisodes: [`h-${id}`],
  runId: "r",
  model: "m",
  generatedAt: "2026-07-01T00:00:00Z",
  situationTag: "tag",
  summary: "开篇摘要。",
  critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
  validateFeianPassed: true,
  reactivationCount: 0,
  ...extra,
});

describe("findLiveById (ADR 0021 — the id join)", () => {
  it("resolves a live record by its exact manifest id", () => {
    const m = emptyManifest();
    m.created.push(rec("a", "live"), rec("b", "live"));
    expect(findLiveById(m, "b")?.id).toBe("b");
  });

  it("picks only LIVE records: an archived id resolves to undefined", () => {
    const m = emptyManifest();
    m.created.push(rec("a", "archived"), rec("b", "live"));
    expect(findLiveById(m, "a")).toBeUndefined();
    expect(findLiveById(m, "b")?.id).toBe("b");
  });

  it("returns undefined for an unknown, absent, or blank id", () => {
    const m = emptyManifest();
    m.created.push(rec("a", "live"));
    expect(findLiveById(m, "no-such-id")).toBeUndefined();
    expect(findLiveById(m, undefined)).toBeUndefined();
    expect(findLiveById(m, "")).toBeUndefined();
    expect(findLiveById(m, "   ")).toBeUndefined();
  });

  it("trims whitespace around the model-returned id", () => {
    const m = emptyManifest();
    m.created.push(rec("a", "live"));
    expect(findLiveById(m, "  a  ")?.id).toBe("a");
  });
});
