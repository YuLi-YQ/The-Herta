import { describe, expect, it } from "vitest";
import {
  HERTA_NAME_AMBIGUOUS,
  HERTA_PERSON_PRIME,
  HERTA_PLACE_SPACE_STATION,
} from "../schema.js";
import type { LabelChunkResult } from "./deterministic-labeler.js";
import { selectLlmCandidates } from "./select-llm-candidates.js";

function mkLabel(
  chunkId: string,
  mentions: Array<{
    surface: string;
    referentEntityId: string;
    confidence: number;
  }>,
  isHertaVoiceEvidence = false,
): LabelChunkResult {
  return {
    chunkId,
    pageSubjectEntityId: undefined,
    isHertaVoiceEvidence,
    isCanonFactCandidate: false,
    mentions: mentions.map((m) => ({
      surface: m.surface,
      referentEntityId: m.referentEntityId,
      confidence: m.confidence,
      method: "deterministic" as const,
    })),
  };
}

describe("selectLlmCandidates", () => {
  it("selects chunks with a herta.name.ambiguous mention", () => {
    const labels = [
      mkLabel("c1", [
        {
          surface: "黑塔",
          referentEntityId: HERTA_NAME_AMBIGUOUS,
          confidence: 0.55,
        },
      ]),
      mkLabel("c2", [
        {
          surface: "大黑塔",
          referentEntityId: HERTA_PERSON_PRIME,
          confidence: 0.99,
        },
      ]),
    ];
    const out = selectLlmCandidates(labels, 100);
    expect(out.map((l) => l.chunkId)).toEqual(["c1"]);
  });

  it("selects speaker-黑塔 chunks with deterministic confidence < 0.85", () => {
    const labels = [
      mkLabel(
        "c1",
        [
          {
            surface: "黑塔",
            referentEntityId: HERTA_PERSON_PRIME,
            confidence: 0.7,
          },
        ],
        true,
      ),
    ];
    const out = selectLlmCandidates(labels, 100);
    expect(out).toHaveLength(1);
  });

  it("does NOT select fully-resolved chunks (no ambiguity, all confidence ≥ 0.85)", () => {
    const labels = [
      mkLabel("c1", [
        {
          surface: "空间站「黑塔」",
          referentEntityId: HERTA_PLACE_SPACE_STATION,
          confidence: 0.99,
        },
      ]),
    ];
    const out = selectLlmCandidates(labels, 100);
    expect(out).toEqual([]);
  });

  it("respects max-llm-chunks cap", () => {
    const labels = [
      mkLabel("c1", [
        {
          surface: "黑塔",
          referentEntityId: HERTA_NAME_AMBIGUOUS,
          confidence: 0.5,
        },
      ]),
      mkLabel("c2", [
        {
          surface: "黑塔",
          referentEntityId: HERTA_NAME_AMBIGUOUS,
          confidence: 0.5,
        },
      ]),
      mkLabel("c3", [
        {
          surface: "黑塔",
          referentEntityId: HERTA_NAME_AMBIGUOUS,
          confidence: 0.5,
        },
      ]),
    ];
    const out = selectLlmCandidates(labels, 2);
    expect(out).toHaveLength(2);
    expect(out.map((l) => l.chunkId)).toEqual(["c1", "c2"]);
  });

  it("returns empty when all labels are fully resolved", () => {
    expect(selectLlmCandidates([], 100)).toEqual([]);
  });
});
