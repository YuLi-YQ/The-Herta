import { describe, expect, it } from "vitest";
import {
  loadMetaThinkCorpus,
  MOOD_DESCRIPTIONS,
  MOOD_STATES,
  type MoodState,
  moodDescriptions,
  resolveMetaThink,
} from "./meta-think.js";
import { PROMPT_ASSETS, PROMPT_ASSETS_EN } from "./prompt-assets.generated.js";

describe("MOOD_STATES constant", () => {
  it("contains exactly the eight canonical states in order", () => {
    expect(MOOD_STATES).toEqual([
      "默认",
      "被烦版",
      "教学版",
      "被戳穿版",
      "任务部署版",
      "板砖代答版",
      "被顶嘴版",
      "倾听版",
    ]);
  });
});

describe("loadMetaThinkCorpus (compiled assets, M-prompts-1)", () => {
  it("covers all 8 states for both surfaces with non-empty compiled content", () => {
    const corpus = loadMetaThinkCorpus();
    for (const s of MOOD_STATES) {
      expect(corpus.preThink[s].length, `preThink ${s}`).toBeGreaterThan(0);
      expect(corpus.preSpeak[s].length, `preSpeak ${s}`).toBeGreaterThan(0);
    }
  });

  it("trims trailing whitespace but preserves internal line breaks", () => {
    const corpus = loadMetaThinkCorpus();
    for (const s of MOOD_STATES) {
      expect(corpus.preThink[s]).toBe(corpus.preThink[s].trimEnd());
      expect(corpus.preSpeak[s]).toBe(corpus.preSpeak[s].trimEnd());
    }
    // Matches the compiled source (modulo the trailing trim).
    expect(corpus.preSpeak.默认).toBe(
      PROMPT_ASSETS.metaThink.preSpeak.默认?.trimEnd(),
    );
    expect(corpus.preThink.默认).toBe(
      PROMPT_ASSETS.metaThink.preThink.默认?.trimEnd(),
    );
  });

  it("is deterministic across calls", () => {
    expect(loadMetaThinkCorpus()).toEqual(loadMetaThinkCorpus());
  });

  it('default equals explicit lang: "zh" (zh identity, slice 4)', () => {
    expect(loadMetaThinkCorpus("zh")).toEqual(loadMetaThinkCorpus());
  });

  it('lang: "en" loads the EN bundle under the SAME CN MoodState keys (slice 4)', () => {
    const corpus = loadMetaThinkCorpus("en");
    for (const s of MOOD_STATES) {
      expect(corpus.preThink[s].length, `preThink ${s}`).toBeGreaterThan(0);
      expect(corpus.preSpeak[s].length, `preSpeak ${s}`).toBeGreaterThan(0);
    }
    expect(corpus.preThink.默认).toBe(
      PROMPT_ASSETS_EN.metaThink.preThink.默认?.trimEnd(),
    );
    expect(corpus.preThink.默认).not.toBe(
      PROMPT_ASSETS.metaThink.preThink.默认?.trimEnd(),
    );
  });
});

describe("resolveMetaThink", () => {
  function corpus(overrides: {
    preThink?: Partial<Record<MoodState, string>>;
    preSpeak?: Partial<Record<MoodState, string>>;
  }): import("./meta-think.js").MetaThinkCorpus {
    const emptyMap = (): Record<MoodState, string> => ({
      默认: "",
      被烦版: "",
      教学版: "",
      被戳穿版: "",
      任务部署版: "",
      板砖代答版: "",
      被顶嘴版: "",
      倾听版: "",
    });
    return {
      preThink: { ...emptyMap(), ...(overrides.preThink ?? {}) },
      preSpeak: { ...emptyMap(), ...(overrides.preSpeak ?? {}) },
    };
  }

  it("returns the requested state's text when present", () => {
    const c = corpus({ preThink: { 被烦版: "ANNOYED" } });
    expect(resolveMetaThink(c, "thought", "被烦版")).toBe("ANNOYED");
  });

  it("falls back to 默认 when the requested state is empty", () => {
    const c = corpus({ preSpeak: { 默认: "DEFAULT" } });
    expect(resolveMetaThink(c, "speech", "被顶嘴版")).toBe("DEFAULT");
  });

  it("returns '' when both the requested state and 默认 are empty", () => {
    const c = corpus({});
    expect(resolveMetaThink(c, "thought", "教学版")).toBe("");
  });

  it("uses preThink for thought surface and preSpeak for speech surface", () => {
    const c = corpus({
      preThink: { 默认: "T" },
      preSpeak: { 默认: "S" },
    });
    expect(resolveMetaThink(c, "thought", "默认")).toBe("T");
    expect(resolveMetaThink(c, "speech", "默认")).toBe("S");
  });
});

describe("MOOD_DESCRIPTIONS constant", () => {
  it("has an entry for every MoodState in MOOD_STATES", () => {
    for (const state of MOOD_STATES) {
      expect(MOOD_DESCRIPTIONS[state]).toBeDefined();
      expect(MOOD_DESCRIPTIONS[state].length).toBeGreaterThan(0);
    }
  });

  it("does NOT contain any extra keys beyond MOOD_STATES", () => {
    const descKeys = Object.keys(MOOD_DESCRIPTIONS) as readonly string[];
    expect(new Set(descKeys)).toEqual(new Set(MOOD_STATES));
  });

  it("descriptions are first-person Herta voice (use 我, not a generic-assistant tone)", () => {
    for (const state of MOOD_STATES) {
      const desc = MOOD_DESCRIPTIONS[state];
      expect(desc).toContain("我");
    }
  });
});

describe("moodDescriptions (EN interaction slice 3b)", () => {
  it('defaults to "zh" and returns the exact back-compat MOOD_DESCRIPTIONS map', () => {
    expect(moodDescriptions()).toBe(MOOD_DESCRIPTIONS);
    expect(moodDescriptions("zh")).toBe(MOOD_DESCRIPTIONS);
  });

  it('lang:"en" covers all seven CN state keys with non-empty English prose', () => {
    const en = moodDescriptions("en");
    expect(new Set(Object.keys(en))).toEqual(new Set(MOOD_STATES));
    for (const state of MOOD_STATES) {
      const desc = en[state];
      expect(desc.length, state).toBeGreaterThan(0);
      // First-person English prose, no zh-variant leftovers.
      expect(desc, state).toContain("I ");
      expect(desc, state).not.toContain("开拓者");
    }
    // Official-glossary appellation where the counterpart names 开拓者.
    expect(en.被烦版).toContain("The Trailblazer");
  });

  it('lang:"en" keeps the @板砖/板砖 tokens CN (machine contract, D2/D7/D8)', () => {
    const en = moodDescriptions("en");
    expect(en.任务部署版).toContain("@板砖");
    expect(en.板砖代答版).toContain("@板砖");
  });
});
