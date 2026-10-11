import { describe, expect, it } from "vitest";
import { parseSynthesisOutput } from "./synthesize-output-validator.js";

const VALID_SELF_MODEL = {
  version: 1,
  generated_at: "2026-05-10T14:20:00Z",
  provenance: {
    passes: [
      { name: "fact-extract", model: "deepseek-v4-pro" },
      { name: "synthesize", model: "deepseek-v4-pro" },
    ],
  },
  biography: {
    prose: "我是黑塔本人，天才俱乐部 #83。",
    key_facts: [{ fact: "Genius Society #83", evidence: ["019_大黑塔.html"] }],
  },
  philosophy: {
    prose: "我看重效率。",
    key_facts: [],
  },
  embodiment: {
    prose: "我的工坊在空间站。",
    key_facts: [],
  },
  relationships: {
    screwllum: {
      prose: "螺丝咕姆是同辈，技术对话直来直去。",
      evidence: ["019_大黑塔.html"],
    },
  },
  harness_proprioception: {
    prose: "我桌上有一个文字终端，是我跟用户和coding subagent交谈的工具。",
    key_facts: [],
  },
  anti_patterns: [
    { rule: "I do not return 你好 greetings politely.", evidence: [] },
  ],
  interaction_register: {
    prose: "对小事直接，对难题靠近。",
    samples: [{ scenario: "casual greeting", voice_sample: "啧。说事。" }],
  },
};

describe("parseSynthesisOutput", () => {
  it("returns ok for a fully valid self-model", () => {
    const r = parseSynthesisOutput(JSON.stringify(VALID_SELF_MODEL));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.selfModel.biography.prose).toContain("天才俱乐部");
      expect(r.warnings).toEqual([]);
    }
  });

  it("returns invalid_json on malformed input", () => {
    const r = parseSynthesisOutput("not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_json");
  });

  it("strips a markdown fence", () => {
    const wrapped = `\`\`\`json\n${JSON.stringify(VALID_SELF_MODEL)}\n\`\`\``;
    const r = parseSynthesisOutput(wrapped);
    expect(r.ok).toBe(true);
  });

  it("returns schema_invalid when a required slot is missing", () => {
    const bad = { ...VALID_SELF_MODEL };
    delete (bad as Record<string, unknown>).philosophy;
    const r = parseSynthesisOutput(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("schema_invalid");
  });

  it("warns when biography prose contains third-person 'Herta is'", () => {
    const bad = {
      ...VALID_SELF_MODEL,
      biography: {
        prose: "Herta is Genius Society member #83.",
        key_facts: [],
      },
    };
    const r = parseSynthesisOutput(JSON.stringify(bad));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings).toContainEqual(
        expect.objectContaining({ kind: "third_person_voice" }),
      );
    }
  });

  it("warns when harness_proprioception prose contains 'I am the CLI' framing", () => {
    const bad = {
      ...VALID_SELF_MODEL,
      harness_proprioception: {
        prose: "I am Herta CLI, a text channel.",
        key_facts: [],
      },
    };
    const r = parseSynthesisOutput(JSON.stringify(bad));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings).toContainEqual(
        expect.objectContaining({ kind: "cli_as_self" }),
      );
    }
  });

  it("warns when biography prose opens with a literal '你好' greeting", () => {
    const bad = {
      ...VALID_SELF_MODEL,
      biography: {
        prose: "你好。我是黑塔本人。",
        key_facts: [],
      },
    };
    const r = parseSynthesisOutput(JSON.stringify(bad));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings).toContainEqual(
        expect.objectContaining({ kind: "ni_hao_opener" }),
      );
    }
  });

  it("does not warn when prose is in first-person and harness is tool-framed", () => {
    const r = parseSynthesisOutput(JSON.stringify(VALID_SELF_MODEL));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toEqual([]);
  });

  it("returns invalid_json when output is plain prose (no JSON object at all)", () => {
    const r = parseSynthesisOutput("Sure! Here's the JSON I generated:\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_json");
  });

  it("emits multiple warnings when several issues are present", () => {
    const bad = {
      ...VALID_SELF_MODEL,
      biography: {
        prose: "Herta is at her workshop. 你好.",
        key_facts: [],
      },
      harness_proprioception: {
        prose: "I am Herta CLI.",
        key_facts: [],
      },
    };
    const r = parseSynthesisOutput(JSON.stringify(bad));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings.length).toBeGreaterThanOrEqual(2);
    }
  });
});
