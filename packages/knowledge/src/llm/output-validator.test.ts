import { describe, expect, it } from "vitest";
import { parseAndValidateLlmOutput } from "./output-validator.js";

const allowedChunkIds = new Set(["c1", "c2"]);

describe("parseAndValidateLlmOutput", () => {
  it("returns the parsed annotation for a well-formed response", () => {
    const raw = JSON.stringify({
      chunks: [
        {
          chunk_id: "c1",
          mentions: [
            {
              surface: "黑塔",
              referent_entity_id: "herta.person.prime",
              embodiment_entity_id: "herta.form.doll",
              speaker_entity_id: "herta.person.prime",
              confidence: 0.86,
              rationale: "test",
            },
          ],
          is_herta_voice_evidence: true,
        },
      ],
    });
    const out = parseAndValidateLlmOutput(raw, allowedChunkIds);
    expect(out.rejected).toEqual([]);
    expect(out.accepted).toHaveLength(1);
    const a = out.accepted[0];
    expect(a?.chunkId).toBe("c1");
    expect(a?.isHertaVoiceEvidence).toBe(true);
    expect(a?.mentions).toHaveLength(1);
    expect(a?.mentions[0]?.referentEntityId).toBe("herta.person.prime");
    expect(a?.mentions[0]?.embodimentEntityId).toBe("herta.form.doll");
    expect(a?.mentions[0]?.confidence).toBe(0.86);
  });

  it("rejects a chunk whose chunk_id is not in the allowed set", () => {
    const raw = JSON.stringify({
      chunks: [
        {
          chunk_id: "unknown",
          mentions: [
            {
              surface: "黑塔",
              referent_entity_id: "herta.person.prime",
              confidence: 0.9,
            },
          ],
          is_herta_voice_evidence: false,
        },
      ],
    });
    const out = parseAndValidateLlmOutput(raw, allowedChunkIds);
    expect(out.accepted).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]?.reason).toMatch(/unknown chunk_id/i);
  });

  it("rejects a mention with unknown entity ID", () => {
    const raw = JSON.stringify({
      chunks: [
        {
          chunk_id: "c1",
          mentions: [
            {
              surface: "黑塔",
              referent_entity_id: "herta.invented.id",
              confidence: 0.9,
            },
          ],
          is_herta_voice_evidence: false,
        },
      ],
    });
    const out = parseAndValidateLlmOutput(raw, allowedChunkIds);
    expect(out.accepted).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]?.reason).toMatch(/unknown entity/i);
  });

  it("rejects a mention with confidence > 1 or < 0", () => {
    const rawHigh = JSON.stringify({
      chunks: [
        {
          chunk_id: "c1",
          mentions: [
            {
              surface: "黑塔",
              referent_entity_id: "herta.person.prime",
              confidence: 1.5,
            },
          ],
          is_herta_voice_evidence: false,
        },
      ],
    });
    expect(
      parseAndValidateLlmOutput(rawHigh, allowedChunkIds).accepted,
    ).toHaveLength(0);
    const rawNeg = JSON.stringify({
      chunks: [
        {
          chunk_id: "c1",
          mentions: [
            {
              surface: "黑塔",
              referent_entity_id: "herta.person.prime",
              confidence: -0.1,
            },
          ],
          is_herta_voice_evidence: false,
        },
      ],
    });
    expect(
      parseAndValidateLlmOutput(rawNeg, allowedChunkIds).accepted,
    ).toHaveLength(0);
  });

  it("rejects an entirely unparseable response", () => {
    const out = parseAndValidateLlmOutput(
      "not json {}{ broken",
      allowedChunkIds,
    );
    expect(out.accepted).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]?.reason).toMatch(/json parse/i);
  });

  it("partial-rejects: keeps valid chunks, drops bad ones", () => {
    const raw = JSON.stringify({
      chunks: [
        {
          chunk_id: "c1",
          mentions: [
            {
              surface: "黑塔",
              referent_entity_id: "herta.person.prime",
              confidence: 0.9,
            },
          ],
          is_herta_voice_evidence: true,
        },
        {
          chunk_id: "unknown",
          mentions: [],
          is_herta_voice_evidence: false,
        },
      ],
    });
    const out = parseAndValidateLlmOutput(raw, allowedChunkIds);
    expect(out.accepted).toHaveLength(1);
    expect(out.accepted[0]?.chunkId).toBe("c1");
    expect(out.rejected).toHaveLength(1);
  });

  it("allows herta.name.ambiguous as a valid entity ID", () => {
    const raw = JSON.stringify({
      chunks: [
        {
          chunk_id: "c1",
          mentions: [
            {
              surface: "黑塔",
              referent_entity_id: "herta.name.ambiguous",
              confidence: 0.4,
            },
          ],
          is_herta_voice_evidence: false,
        },
      ],
    });
    const out = parseAndValidateLlmOutput(raw, allowedChunkIds);
    expect(out.accepted).toHaveLength(1);
    expect(out.accepted[0]?.mentions[0]?.referentEntityId).toBe(
      "herta.name.ambiguous",
    );
  });
});
