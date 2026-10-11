import { describe, expect, it } from "vitest";
import {
  HERTA_FORM_DOLL,
  HERTA_NAME_AMBIGUOUS,
  HERTA_PERSON_PRIME,
  HERTA_PLACE_SPACE_STATION,
} from "../schema.js";
import { applyMentionOverrides } from "./override-applier.js";
import type { MentionOverride } from "./override-loader.js";

const baseMention = {
  surface: "黑塔",
  referentEntityId: HERTA_NAME_AMBIGUOUS,
  pageSubjectEntityId: undefined as string | undefined,
  confidence: 0.55,
  method: "deterministic" as const,
};

describe("applyMentionOverrides", () => {
  it("returns mentions unchanged when no overrides match", () => {
    const overrides: MentionOverride[] = [
      {
        chunkId: "other-chunk",
        surface: "黑塔",
        referentEntityId: HERTA_PERSON_PRIME,
        confidence: 1.0,
      },
    ];
    const out = applyMentionOverrides("c1", [baseMention], overrides);
    expect(out).toEqual([baseMention]);
  });

  it("rewrites a matching mention's referent + confidence + method", () => {
    const overrides: MentionOverride[] = [
      {
        chunkId: "c1",
        surface: "黑塔",
        referentEntityId: HERTA_PLACE_SPACE_STATION,
        confidence: 1.0,
        note: "operator review",
      },
    ];
    const out = applyMentionOverrides("c1", [baseMention], overrides);
    expect(out[0]?.referentEntityId).toBe(HERTA_PLACE_SPACE_STATION);
    expect(out[0]?.confidence).toBe(1.0);
    expect(out[0]?.method).toBe("human_review");
    expect(out[0]?.rationale).toContain("operator review");
  });

  it("preserves embodiment from override when provided", () => {
    const overrides: MentionOverride[] = [
      {
        chunkId: "c1",
        surface: "黑塔",
        referentEntityId: HERTA_PERSON_PRIME,
        embodimentEntityId: HERTA_FORM_DOLL,
        confidence: 0.95,
      },
    ];
    const out = applyMentionOverrides("c1", [baseMention], overrides);
    expect(out[0]?.embodimentEntityId).toBe(HERTA_FORM_DOLL);
  });

  it("only rewrites mentions matching surface", () => {
    const otherSurface = { ...baseMention, surface: "大黑塔" };
    const overrides: MentionOverride[] = [
      {
        chunkId: "c1",
        surface: "黑塔",
        referentEntityId: HERTA_PLACE_SPACE_STATION,
        confidence: 1.0,
      },
    ];
    const out = applyMentionOverrides(
      "c1",
      [baseMention, otherSurface],
      overrides,
    );
    expect(out[0]?.referentEntityId).toBe(HERTA_PLACE_SPACE_STATION);
    expect(out[1]?.surface).toBe("大黑塔");
    expect(out[1]?.referentEntityId).toBe(HERTA_NAME_AMBIGUOUS);
  });

  it("applies last-wins when multiple overrides match the same pair", () => {
    const overrides: MentionOverride[] = [
      {
        chunkId: "c1",
        surface: "黑塔",
        referentEntityId: HERTA_PERSON_PRIME,
        confidence: 0.8,
      },
      {
        chunkId: "c1",
        surface: "黑塔",
        referentEntityId: HERTA_PLACE_SPACE_STATION,
        confidence: 1.0,
      },
    ];
    const out = applyMentionOverrides("c1", [baseMention], overrides);
    expect(out[0]?.referentEntityId).toBe(HERTA_PLACE_SPACE_STATION);
    expect(out[0]?.confidence).toBe(1.0);
  });
});
