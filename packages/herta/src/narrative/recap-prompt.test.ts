import { describe, expect, it } from "vitest";
import { buildRecapPrompt, validateRecap } from "./recap-prompt.js";

describe("buildRecapPrompt", () => {
  it("injects the guide, the must-survive checklist, and the aged turns", () => {
    const { system, user } = buildRecapPrompt({
      prevRecap: "之前的回忆",
      agedTurnsText: "（开拓者 说）\n问\n（/开拓者 说）",
      guide: "语气不变量XYZ",
      bio: "",
      maxChars: 800,
      isRederive: false,
    });
    expect(system).toContain("第一人称");
    expect(system).toContain("必须保留");
    expect(system).toContain("语气不变量XYZ");
    expect(system).toContain("800");
    expect(user).toContain("之前的回忆");
    expect(user).toContain("问");
  });

  it("omits the prior recap on a re-derive", () => {
    const { user } = buildRecapPrompt({
      prevRecap: "不该出现",
      agedTurnsText: "原始",
      guide: "g",
      bio: "",
      maxChars: 800,
      isRederive: true,
    });
    expect(user).not.toContain("不该出现");
    expect(user).toContain("原始");
  });

  it("omits the prior-recap block on first engage (prevRecap null, not a re-derive)", () => {
    const { user } = buildRecapPrompt({
      prevRecap: null,
      agedTurnsText: "原始",
      guide: "g",
      bio: "",
      maxChars: 800,
      isRederive: false,
    });
    expect(user).not.toContain("已有的回忆");
    expect(user).toContain("原始");
  });

  it("omits the guide section when the guide is empty", () => {
    const { system } = buildRecapPrompt({
      prevRecap: null,
      agedTurnsText: "原始",
      guide: "",
      bio: "",
      maxChars: 800,
      isRederive: false,
    });
    expect(system).not.toContain("以下是你的说话指南");
    expect(system.endsWith("\n")).toBe(false);
  });

  it("injects the HertaBio voice anchor (tone-not-content), and omits it when empty", () => {
    const withBio = buildRecapPrompt({
      prevRecap: null,
      agedTurnsText: "原始",
      guide: "",
      bio: "## 序\n有人问我为什么要写自传。",
      maxChars: 800,
      isRederive: false,
    });
    expect(withBio.system).toContain("你自传的开头"); // anchor framing
    expect(withBio.system).toContain("绝不要照搬其中的内容"); // tone-not-content caveat
    expect(withBio.system).toContain("有人问我为什么要写自传"); // the excerpt itself

    const noBio = buildRecapPrompt({
      prevRecap: null,
      agedTurnsText: "原始",
      guide: "",
      bio: "",
      maxChars: 800,
      isRederive: false,
    });
    expect(noBio.system).not.toContain("你自传的开头");
  });
});

describe("buildRecapPrompt lang (EN interaction slice 3b)", () => {
  const base = {
    prevRecap: "之前的回忆",
    agedTurnsText: "（开拓者 说）\n问\n（/开拓者 说）",
    guide: "语气不变量XYZ",
    bio: "## 序\n有人问我为什么要写自传。",
    maxChars: 800,
    isRederive: false,
  };

  it('default output is byte-identical to lang:"zh"', () => {
    expect(buildRecapPrompt(base)).toEqual(
      buildRecapPrompt({ ...base, lang: "zh" }),
    );
  });

  it('lang:"en" swaps the instruction prose but keeps the CN fence tokens verbatim', () => {
    const { system, user } = buildRecapPrompt({ ...base, lang: "en" });
    // EN sentinels
    expect(system).toContain("You are Herta");
    expect(system).toContain("authoritative fact");
    expect(system).toContain("800");
    expect(user).toContain(
      "[existing recollection (on file — the text your addendum continues; do not copy)]",
    );
    expect(user).toContain("[raw conversation (authoritative facts)]");
    // no CN instruction prose leaks
    expect(system).not.toContain("你是黑塔");
    expect(system).not.toContain("必须保留");
    // structural narrative-grammar tokens stay CN in the EN variant (D2/D7/D8)
    expect(system).toContain("（我 说）");
    expect(system).toContain("（开拓者 说）");
    // injected payloads flow through unchanged
    expect(system).toContain("语气不变量XYZ");
    expect(system).toContain("有人问我为什么要写自传");
    expect(user).toContain("之前的回忆");
  });
});

describe("validateRecap", () => {
  it("accepts clean prose", () => {
    expect(validateRecap("我记得开拓者问过我归并排序。", 800)).toEqual({
      ok: true,
    });
  });
  it("rejects dialogue fences", () => {
    expect(validateRecap("（我 说）\n喏\n（/我 说）", 800).ok).toBe(false);
    expect(validateRecap("（开拓者 说）问", 800).ok).toBe(false);
    expect(validateRecap("回忆中他说（我 想）这不对。", 800).ok).toBe(false);
    expect(validateRecap("（/开拓者 说）收尾。", 800).ok).toBe(false);
  });
  it("accepts innocent spaced parentheticals — only real speakers are fences", () => {
    // Each of these tripped the old any-speaker heuristic; a false reject
    // counts as a summarizer failure and feeds the circuit breaker.
    expect(validateRecap("（总的来 说）这一天过得还行。", 800).ok).toBe(true);
    expect(validateRecap("他愣了半天（我当时 想）才反应过来。", 800).ok).toBe(
      true,
    );
    expect(validateRecap("那件事（换句话 说）就是白忙一场。", 800).ok).toBe(
      true,
    );
  });
  it("rejects empty and over-length", () => {
    expect(validateRecap("   ", 800).ok).toBe(false);
    expect(validateRecap("啊".repeat(801), 800).ok).toBe(false);
  });
});
