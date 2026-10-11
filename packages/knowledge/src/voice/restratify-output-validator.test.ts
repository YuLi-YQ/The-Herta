import { describe, expect, it } from "vitest";
import { validateRestratifyOutput } from "./restratify-output-validator.js";

const KNOWN_ENTITIES = new Set([
  "person.ruan_mei",
  "person.screwllum",
  "aeon.nous",
]);

describe("validateRestratifyOutput", () => {
  it("accepts a well-formed response and returns parsed classifications", () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      classifications: [
        {
          chunk_id: "c1",
          addressee_class: "player",
          addressee_entity_id: null,
          mood: "interested",
          register_mode: "teaching",
          grounded_citation: "嗯？小家伙",
          reasoning: "addresses player directly",
        },
      ],
    });
    const out = validateRestratifyOutput(json, {
      expectedChunkIds: ["c1"],
      knownEntityIds: KNOWN_ENTITIES,
      sourceHtml: "嗯？小家伙来了",
    });
    expect(out.classifications.length).toBe(1);
    expect(out.classifications[0]?.addressee_class).toBe("player");
  });

  it("coerces hallucinated entity IDs to unknown", () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      classifications: [
        {
          chunk_id: "c1",
          addressee_class: "other_named",
          addressee_entity_id: "person.fake_npc",
          mood: null,
          register_mode: null,
          grounded_citation: "嗯？",
          reasoning: "x",
        },
      ],
    });
    const out = validateRestratifyOutput(json, {
      expectedChunkIds: ["c1"],
      knownEntityIds: KNOWN_ENTITIES,
      sourceHtml: "嗯？",
    });
    expect(out.classifications[0]?.addressee_class).toBe("unknown");
    expect(out.classifications[0]?.addressee_entity_id).toBeUndefined();
    expect(out.coercions.length).toBe(1);
  });

  it("demotes verdicts whose grounded_citation isn't in the HTML", () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      classifications: [
        {
          chunk_id: "c1",
          addressee_class: "player",
          addressee_entity_id: null,
          mood: null,
          register_mode: null,
          grounded_citation: "this string is not in the html",
          reasoning: "x",
        },
      ],
    });
    const out = validateRestratifyOutput(json, {
      expectedChunkIds: ["c1"],
      knownEntityIds: KNOWN_ENTITIES,
      sourceHtml: "嗯？小家伙来了",
    });
    expect(out.classifications[0]?.addressee_class).toBe("unknown");
  });

  it("throws DeepSeekShapeError on missing chunk", () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      classifications: [],
    });
    expect(() =>
      validateRestratifyOutput(json, {
        expectedChunkIds: ["c1"],
        knownEntityIds: KNOWN_ENTITIES,
        sourceHtml: "x",
      }),
    ).toThrow(/missing classification/i);
  });
});
