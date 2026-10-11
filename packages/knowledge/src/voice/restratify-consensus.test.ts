import { describe, expect, it } from "vitest";
import { reduceConsensus } from "./restratify-consensus.js";
import type { RestratifyClassification } from "./restratify-output-validator.js";

const A: RestratifyClassification = {
  chunk_id: "c1",
  addressee_class: "player",
  addressee_entity_id: undefined,
  mood: "interested",
  register_mode: "teaching",
  grounded_citation: "x",
  reasoning: "a",
};
const B: RestratifyClassification = { ...A, reasoning: "b" };

describe("reduceConsensus", () => {
  it("agreement → consensus row", () => {
    const out = reduceConsensus(A, B);
    expect(out.source).toBe("consensus");
    expect(out.addressee_class).toBe("player");
    expect(out.confidence).toBeGreaterThan(0.5);
  });

  it("disagreement on class → disagreement row, addressee_class=unknown", () => {
    const out = reduceConsensus(A, {
      ...B,
      addressee_class: "other_named",
      addressee_entity_id: "person.ruan_mei",
    });
    expect(out.source).toBe("disagreement");
    expect(out.addressee_class).toBe("unknown");
    expect(out.confidence).toBeLessThan(0.5);
  });

  it("disagreement on entity_id → disagreement", () => {
    const aOther: RestratifyClassification = {
      ...A,
      addressee_class: "other_named",
      addressee_entity_id: "person.ruan_mei",
    };
    const bOther: RestratifyClassification = {
      ...A,
      addressee_class: "other_named",
      addressee_entity_id: "person.screwllum",
    };
    const out = reduceConsensus(aOther, bOther);
    expect(out.source).toBe("disagreement");
  });

  it("preserves both pass verdicts as JSON", () => {
    const out = reduceConsensus(A, B);
    expect(out.pass_a_verdict_json).toContain('"reasoning":"a"');
    expect(out.pass_b_verdict_json).toContain('"reasoning":"b"');
  });

  it("uses pass A's mood/register on consensus when both agree, otherwise drops them", () => {
    const out = reduceConsensus(A, { ...B, mood: "annoyed" });
    expect(out.mood).toBeUndefined();
    const out2 = reduceConsensus(A, B);
    expect(out2.mood).toBe("interested");
  });
});
