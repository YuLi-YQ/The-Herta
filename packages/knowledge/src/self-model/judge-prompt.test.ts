import { describe, expect, it } from "vitest";
import type { AntiPattern, DefaultRegister } from "../schema.js";
import { buildJudgePrompt } from "./judge-prompt.js";
import type { HertaSelfModelV1 } from "./schema.js";

const MODEL: HertaSelfModelV1 = {
  version: 1,
  generated_at: "2026-05-10T14:00:00Z",
  provenance: {
    passes: [
      { name: "fact-extract", model: "deepseek-v4-pro" },
      { name: "synthesize", model: "deepseek-v4-pro" },
    ],
  },
  biography: { prose: "我是黑塔。", key_facts: [] },
  philosophy: { prose: "我看重效率。", key_facts: [] },
  embodiment: { prose: "工坊在空间站。", key_facts: [] },
  relationships: {},
  harness_proprioception: { prose: "终端是工具。", key_facts: [] },
  anti_patterns: [],
  interaction_register: { prose: "直接。", samples: [] },
};

const VOICE: DefaultRegister = {
  formsOfAddress: [
    { phrase: "小家伙", contextHint: undefined, evidenceChunkIds: [] },
  ],
  toneInvariants: [],
  codeSwitchTriggers: [],
  moodModulators: {},
};

const ANTI_PATTERNS: AntiPattern[] = [
  {
    pattern: "She does not return 你好 greetings politely.",
    rationale: "x",
    evidenceAbsenceClaim: "y",
  },
];

describe("buildJudgePrompt", () => {
  it("returns systemPrompt and userPayload", () => {
    const out = buildJudgePrompt({
      selfModel: MODEL,
      voiceRegister: VOICE,
      antiPatterns: ANTI_PATTERNS,
    });
    expect(out.systemPrompt.length).toBeGreaterThan(0);
    expect(out.userPayload.length).toBeGreaterThan(0);
  });

  it("system prompt is in Chinese", () => {
    const out = buildJudgePrompt({
      selfModel: MODEL,
      voiceRegister: VOICE,
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain("评分");
    expect(out.systemPrompt).toContain("打分");
  });

  it("system prompt enumerates the four rubric dimensions", () => {
    const out = buildJudgePrompt({
      selfModel: MODEL,
      voiceRegister: VOICE,
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain("in_voice");
    expect(out.systemPrompt).toContain("canon_grounded");
    expect(out.systemPrompt).toContain("coherent");
    expect(out.systemPrompt).toContain("no_leakage");
  });

  it("system prompt mandates 0-5 integer scores", () => {
    const out = buildJudgePrompt({
      selfModel: MODEL,
      voiceRegister: VOICE,
      antiPatterns: [],
    });
    expect(out.systemPrompt).toMatch(/0\s*[—-]\s*5|0 到 5/);
  });

  it("system prompt enumerates the slots to score", () => {
    const out = buildJudgePrompt({
      selfModel: MODEL,
      voiceRegister: VOICE,
      antiPatterns: [],
    });
    for (const slot of [
      "biography",
      "philosophy",
      "embodiment",
      "harness_proprioception",
      "interaction_register",
      "relationships",
      "anti_patterns",
    ]) {
      expect(out.systemPrompt).toContain(slot);
    }
  });

  it("system prompt mandates JSON-only output (no fences)", () => {
    const out = buildJudgePrompt({
      selfModel: MODEL,
      voiceRegister: VOICE,
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain("只输出 JSON");
    expect(out.systemPrompt).toContain("markdown");
  });

  it("user payload includes the self-model", () => {
    const out = buildJudgePrompt({
      selfModel: MODEL,
      voiceRegister: VOICE,
      antiPatterns: ANTI_PATTERNS,
    });
    expect(out.userPayload).toContain("我是黑塔");
    expect(out.userPayload).toContain("终端是工具");
  });

  it("user payload includes the voice register and anti-patterns", () => {
    const out = buildJudgePrompt({
      selfModel: MODEL,
      voiceRegister: VOICE,
      antiPatterns: ANTI_PATTERNS,
    });
    expect(out.userPayload).toContain("小家伙");
    expect(out.userPayload).toContain("你好");
  });

  it("system prompt instructs concerns array per slot", () => {
    const out = buildJudgePrompt({
      selfModel: MODEL,
      voiceRegister: VOICE,
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain("concerns");
  });

  it("system prompt explains what no_leakage means (CLI-as-self, generic-LLM)", () => {
    const out = buildJudgePrompt({
      selfModel: MODEL,
      voiceRegister: VOICE,
      antiPatterns: [],
    });
    expect(out.systemPrompt).toMatch(/CLI|文字通道|你好/);
    expect(out.systemPrompt).toMatch(/泄漏|leak/i);
  });
});
