import { describe, expect, it } from "vitest";
import type { LlmAnnotatedChunk } from "../llm/output-validator.js";
import {
  HERTA_FORM_DOLL,
  HERTA_NAME_AMBIGUOUS,
  HERTA_PERSON_PRIME,
  HERTA_PLACE_SPACE_STATION,
} from "../schema.js";
import { applyLlmAnnotations } from "./apply-llm-annotations.js";

const baseMention = {
  surface: "黑塔",
  referentEntityId: HERTA_NAME_AMBIGUOUS,
  pageSubjectEntityId: undefined as string | undefined,
  confidence: 0.55,
  method: "deterministic" as const,
};

describe("applyLlmAnnotations", () => {
  it("rewrites a matching surface with high-confidence LLM annotation (method=llm)", () => {
    const annot: LlmAnnotatedChunk = {
      chunkId: "c1",
      mentions: [
        {
          surface: "黑塔",
          referentEntityId: HERTA_PLACE_SPACE_STATION,
          confidence: 0.92,
          rationale: "context",
        },
      ],
      isHertaVoiceEvidence: false,
    };
    const out = applyLlmAnnotations([baseMention], annot);
    expect(out[0]?.referentEntityId).toBe(HERTA_PLACE_SPACE_STATION);
    expect(out[0]?.method).toBe("llm");
    expect(out[0]?.confidence).toBe(0.92);
    expect(out[0]?.rationale).toContain("context");
  });

  it("keeps mid-confidence (0.65–0.84) annotations but with rationale", () => {
    const annot: LlmAnnotatedChunk = {
      chunkId: "c1",
      mentions: [
        {
          surface: "黑塔",
          referentEntityId: HERTA_PERSON_PRIME,
          confidence: 0.7,
          rationale: "uncertain",
        },
      ],
      isHertaVoiceEvidence: false,
    };
    const out = applyLlmAnnotations([baseMention], annot);
    expect(out[0]?.referentEntityId).toBe(HERTA_PERSON_PRIME);
    expect(out[0]?.method).toBe("llm");
    expect(out[0]?.confidence).toBe(0.7);
  });

  it("low-confidence (<0.65) annotations stay ambiguous (method=llm, referent=ambiguous)", () => {
    const annot: LlmAnnotatedChunk = {
      chunkId: "c1",
      mentions: [
        {
          surface: "黑塔",
          referentEntityId: HERTA_PERSON_PRIME,
          confidence: 0.4,
        },
      ],
      isHertaVoiceEvidence: false,
    };
    const out = applyLlmAnnotations([baseMention], annot);
    expect(out[0]?.referentEntityId).toBe(HERTA_NAME_AMBIGUOUS);
    expect(out[0]?.method).toBe("llm");
    expect(out[0]?.confidence).toBe(0.4);
  });

  it("preserves embodimentEntityId from LLM when provided", () => {
    const annot: LlmAnnotatedChunk = {
      chunkId: "c1",
      mentions: [
        {
          surface: "黑塔",
          referentEntityId: HERTA_PERSON_PRIME,
          embodimentEntityId: HERTA_FORM_DOLL,
          confidence: 0.9,
        },
      ],
      isHertaVoiceEvidence: false,
    };
    const out = applyLlmAnnotations([baseMention], annot);
    expect(out[0]?.embodimentEntityId).toBe(HERTA_FORM_DOLL);
  });

  it("appends a new mention when LLM surface doesn't match existing", () => {
    const annot: LlmAnnotatedChunk = {
      chunkId: "c1",
      mentions: [
        {
          surface: "天才俱乐部#83",
          referentEntityId: HERTA_PERSON_PRIME,
          confidence: 0.95,
        },
      ],
      isHertaVoiceEvidence: false,
    };
    const out = applyLlmAnnotations([baseMention], annot);
    expect(out).toHaveLength(2);
    expect(out[1]?.surface).toBe("天才俱乐部#83");
    expect(out[1]?.method).toBe("llm");
  });

  it("preserves existing mentions with non-matching surfaces unchanged", () => {
    const otherMention = {
      ...baseMention,
      surface: "大黑塔",
      referentEntityId: HERTA_PERSON_PRIME,
    };
    const annot: LlmAnnotatedChunk = {
      chunkId: "c1",
      mentions: [
        {
          surface: "黑塔",
          referentEntityId: HERTA_PLACE_SPACE_STATION,
          confidence: 0.9,
        },
      ],
      isHertaVoiceEvidence: false,
    };
    const out = applyLlmAnnotations([baseMention, otherMention], annot);
    expect(out[0]?.referentEntityId).toBe(HERTA_PLACE_SPACE_STATION);
    expect(out[1]?.referentEntityId).toBe(HERTA_PERSON_PRIME);
    expect(out[1]?.method).toBe("deterministic");
  });
});
