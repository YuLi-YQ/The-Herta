import { describe, expect, it } from "vitest";
import type { AntiPattern, DefaultRegister } from "../schema.js";
import type { HertaFacts } from "./schema.js";
import { buildSynthesisPrompt } from "./synthesize-prompt.js";

const ANTI_PATTERNS: AntiPattern[] = [
  {
    pattern: "She does not return 你好 greetings politely.",
    rationale: "Herta's voice is dismissive of casual greetings.",
    evidenceAbsenceClaim: "No 你好 greeting opener in 1173 voice chunks.",
  },
];

const VOICE_REGISTER: DefaultRegister = {
  formsOfAddress: [
    {
      phrase: "小家伙",
      contextHint: "addressing junior interlocutors",
      evidenceChunkIds: [],
    },
  ],
  toneInvariants: [
    {
      pattern: "dismissive opener for unsolicited greetings",
      evidenceChunkIds: [],
    },
  ],
  codeSwitchTriggers: [
    {
      trigger: "technical jargon",
      switchTo: "en",
      evidenceChunkIds: [],
    },
  ],
  moodModulators: {
    pleased: [{ pattern: "嗯，不错", evidenceChunkIds: [] }],
    annoyed: [{ pattern: "啧", evidenceChunkIds: [] }],
  },
};

const FACTS: HertaFacts = {
  version: 1,
  generated_at: "2026-05-10T14:00:00Z",
  provenance: { passes: [{ name: "fact-extract", model: "deepseek-v4-pro" }] },
  files: [
    {
      source: "019_大黑塔.html",
      facts: [
        {
          kind: "biography",
          prose: "她是天才俱乐部 #83。",
          evidence_excerpt: "天才俱乐部 #83",
          confidence: "high",
        },
        {
          kind: "embodiment",
          prose: "她的工坊在「黑塔」空间站。",
          evidence_excerpt: "工坊在空间站",
          confidence: "high",
        },
      ],
    },
  ],
  failures: [],
};

describe("buildSynthesisPrompt", () => {
  it("returns systemPrompt and userPayload", () => {
    const out = buildSynthesisPrompt({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: ANTI_PATTERNS,
    });
    expect(typeof out.systemPrompt).toBe("string");
    expect(typeof out.userPayload).toBe("string");
    expect(out.systemPrompt.length).toBeGreaterThan(0);
    expect(out.userPayload.length).toBeGreaterThan(0);
  });

  it("system prompt is written in Chinese", () => {
    const out = buildSynthesisPrompt({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain("第一人称");
    expect(out.systemPrompt).toContain("约束");
    expect(out.systemPrompt).toContain("禁止");
  });

  it("system prompt mandates first-person voice", () => {
    const out = buildSynthesisPrompt({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain("第一人称");
    expect(out.systemPrompt).toContain("我");
    expect(out.systemPrompt).toContain("黑塔做了");
  });

  it("system prompt mandates the doll-vs-self distinction", () => {
    const out = buildSynthesisPrompt({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain("人偶");
    expect(out.systemPrompt).toContain("doll");
    expect(out.systemPrompt).toContain("大黑塔");
  });

  it("system prompt explicitly forbids CLI-as-self framing", () => {
    const out = buildSynthesisPrompt({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: [],
    });
    // Negation phrasing in either language is acceptable
    expect(out.systemPrompt).toMatch(/我是.*CLI|I am the CLI/);
    expect(out.systemPrompt).toContain("禁止");
  });

  it("system prompt enumerates all (γ) semantic slots", () => {
    const out = buildSynthesisPrompt({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: [],
    });
    for (const slot of [
      "biography",
      "philosophy",
      "embodiment",
      "relationships",
      "harness_proprioception",
      "anti_patterns",
      "interaction_register",
    ]) {
      expect(out.systemPrompt).toContain(slot);
    }
  });

  it("system prompt forbids extrapolation beyond the supplied facts", () => {
    const out = buildSynthesisPrompt({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain("不要推测");
    expect(out.systemPrompt).toContain("严格基于事实");
  });

  it("system prompt requires JSON-only output (no fences, no preamble)", () => {
    const out = buildSynthesisPrompt({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain("只输出 JSON");
    expect(out.systemPrompt).toContain("markdown 围栏");
  });

  it("system prompt mandates Chinese-dominant output language", () => {
    const out = buildSynthesisPrompt({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain("中文为主");
    expect(out.systemPrompt).toMatch(/天才俱乐部.*Genius Society/);
    expect(out.systemPrompt).toContain("孤波算法");
  });

  it("user payload includes the facts JSON", () => {
    const out = buildSynthesisPrompt({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: ANTI_PATTERNS,
    });
    expect(out.userPayload).toContain("019_大黑塔.html");
    expect(out.userPayload).toContain("天才俱乐部 #83");
  });

  it("user payload includes the voice register", () => {
    const out = buildSynthesisPrompt({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: ANTI_PATTERNS,
    });
    expect(out.userPayload).toContain("小家伙");
    expect(out.userPayload).toContain("dismissive opener");
  });

  it("user payload includes the anti-patterns", () => {
    const out = buildSynthesisPrompt({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: ANTI_PATTERNS,
    });
    expect(out.userPayload).toContain("你好");
  });

  it("system prompt instructs writing the harness layer in tool-not-self framing", () => {
    const out = buildSynthesisPrompt({
      facts: FACTS,
      voiceRegister: VOICE_REGISTER,
      antiPatterns: [],
    });
    expect(out.systemPrompt).toMatch(/桌.*工具|桌.*线|terminal.*tool/);
  });
});
