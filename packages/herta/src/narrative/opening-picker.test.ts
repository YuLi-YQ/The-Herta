import { describe, expect, it } from "vitest";
import {
  extractBand,
  parseOpeningFile,
  pickOpening,
  timeBandsAt,
} from "./opening-picker.js";
import { PROMPT_ASSETS, PROMPT_ASSETS_EN } from "./prompt-assets.generated.js";

describe("parseOpeningFile", () => {
  it("parses a valid file into preamble + seedText", () => {
    const content = [
      "茶凉了一半，模拟宇宙今早跑出一个完全说不通的振荡。板砖的指示灯刚从绿转蓝。",
      "",
      "（我 说）",
      "哦，是你。小家伙，什么事？我可没时间，速度。",
      "（/我 说）",
      "",
    ].join("\n");
    const result = parseOpeningFile(content);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.preamble).toBe(
      "茶凉了一半，模拟宇宙今早跑出一个完全说不通的振荡。板砖的指示灯刚从绿转蓝。",
    );
    expect(result.seedText).toBe(
      "哦，是你。小家伙，什么事？我可没时间，速度。",
    );
  });

  it("returns error when （我 说） open tag is missing", () => {
    const content = "茶凉了。\n哦，是你。\n";
    const result = parseOpeningFile(content);
    expect("error" in result).toBe(true);
  });

  it("returns error when （/我 说） close tag is missing", () => {
    const content = "茶凉了。\n\n（我 说）\n哦，是你。\n";
    const result = parseOpeningFile(content);
    expect("error" in result).toBe(true);
  });

  it("returns error when preamble is empty", () => {
    const content = "\n（我 说）\n哦，是你。\n（/我 说）\n";
    const result = parseOpeningFile(content);
    expect("error" in result).toBe(true);
  });

  it("returns error when seed text is empty", () => {
    const content = "茶凉了。\n\n（我 说）\n\n（/我 说）\n";
    const result = parseOpeningFile(content);
    expect("error" in result).toBe(true);
  });

  it("returns error when content exists after （/我 说）", () => {
    const content =
      "茶凉了。\n\n（我 说）\n哦。\n（/我 说）\n\nextra garbage here\n";
    const result = parseOpeningFile(content);
    expect("error" in result).toBe(true);
  });

  it("tolerates leading and trailing whitespace on the file", () => {
    const content = [
      "",
      "",
      "茶凉了。",
      "",
      "（我 说）",
      "哦。",
      "（/我 说）",
      "",
      "",
    ].join("\n");
    const result = parseOpeningFile(content);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.preamble).toBe("茶凉了。");
    expect(result.seedText).toBe("哦。");
  });
});

describe("extractBand", () => {
  it("returns 'midnight' for 028-midnight-reboot.txt", () => {
    expect(extractBand("028-midnight-reboot.txt")).toBe("midnight");
  });

  it("returns 'late-night' for 004-late-night-audit.txt (two-token band)", () => {
    expect(extractBand("004-late-night-audit.txt")).toBe("late-night");
  });

  it("returns 'dawn' for 016-dawn-first-tea.txt", () => {
    expect(extractBand("016-dawn-first-tea.txt")).toBe("dawn");
  });

  it("returns 'morning' for 001-morning-cold-tea.txt", () => {
    expect(extractBand("001-morning-cold-tea.txt")).toBe("morning");
  });

  it("returns 'noon' for 019-noon-charging.txt", () => {
    expect(extractBand("019-noon-charging.txt")).toBe("noon");
  });

  it("returns 'afternoon' for 022-afternoon-drowsy.txt", () => {
    expect(extractBand("022-afternoon-drowsy.txt")).toBe("afternoon");
  });

  it("returns 'evening' for 025-evening-cleanup.txt", () => {
    expect(extractBand("025-evening-cleanup.txt")).toBe("evening");
  });

  it("returns 'neutral' for 002-puppet-twitch.txt", () => {
    expect(extractBand("002-puppet-twitch.txt")).toBe("neutral");
  });

  it("returns 'neutral' for files without NNN- prefix", () => {
    expect(extractBand("freeform-name.txt")).toBe("neutral");
  });

  it("treats 'morning-after-the-quarrel' as 'morning' (first segment match wins)", () => {
    expect(extractBand("999-morning-after-the-quarrel.txt")).toBe("morning");
  });

  it("returns 'neutral' for 'late-pulse-monitoring' (not a band prefix)", () => {
    expect(extractBand("999-late-pulse-monitoring.txt")).toBe("neutral");
  });
});

describe("timeBandsAt", () => {
  it("04..07 → dawn", () => {
    expect(timeBandsAt(4)).toEqual(["dawn"]);
    expect(timeBandsAt(5)).toEqual(["dawn"]);
    expect(timeBandsAt(7)).toEqual(["dawn"]);
  });

  it("08..10 → morning", () => {
    expect(timeBandsAt(8)).toEqual(["morning"]);
    expect(timeBandsAt(10)).toEqual(["morning"]);
  });

  it("11..13 → noon", () => {
    expect(timeBandsAt(11)).toEqual(["noon"]);
    expect(timeBandsAt(13)).toEqual(["noon"]);
  });

  it("14..17 → afternoon", () => {
    expect(timeBandsAt(14)).toEqual(["afternoon"]);
    expect(timeBandsAt(17)).toEqual(["afternoon"]);
  });

  it("18..21 → evening", () => {
    expect(timeBandsAt(18)).toEqual(["evening"]);
    expect(timeBandsAt(21)).toEqual(["evening"]);
  });

  it("22..23 → [midnight, late-night]", () => {
    expect(timeBandsAt(22)).toEqual(["midnight", "late-night"]);
    expect(timeBandsAt(23)).toEqual(["midnight", "late-night"]);
  });

  it("00..03 → [midnight, late-night]", () => {
    expect(timeBandsAt(0)).toEqual(["midnight", "late-night"]);
    expect(timeBandsAt(3)).toEqual(["midnight", "late-night"]);
  });
});

describe("pickOpening — interaction language (slice 4)", () => {
  const noonClock = (): Date => new Date("2026-07-14T12:00:00");

  it("default (zh) pairs voiceClipId = filename stem", () => {
    const choice = pickOpening({ rng: () => 0, clock: () => noonClock() });
    expect(choice).toBeDefined();
    expect(choice?.voiceClipId).toBe(choice?.sourceFile.replace(/\.txt$/, ""));
  });

  it('explicit lang: "zh" behaves identically to the default (zh identity)', () => {
    const implicit = pickOpening({ rng: () => 0, clock: () => noonClock() });
    const explicit = pickOpening({
      lang: "zh",
      rng: () => 0,
      clock: () => noonClock(),
    });
    expect(explicit).toEqual(implicit);
  });

  it('lang: "en" selects the EN bundle and returns NO voiceClipId (no EN wavs v1)', () => {
    const choice = pickOpening({
      lang: "en",
      rng: () => 0,
      clock: () => noonClock(),
    });
    expect(choice).toBeDefined();
    expect(choice?.voiceClipId).toBeUndefined();
    // The content comes from the EN bundle's file of the same name…
    const source = PROMPT_ASSETS_EN.openings[choice?.sourceFile ?? ""];
    expect(source).toBeDefined();
    expect(source).toContain(choice?.seedText ?? "@@no-choice@@");
    // …and differs from the zh file with the same filename.
    expect(PROMPT_ASSETS.openings[choice?.sourceFile ?? ""]).not.toBe(source);
  });

  it('lang: "en" keeps the filename/time-band filter working', () => {
    // At noon only neutral + noon-band files are eligible.
    const choice = pickOpening({
      lang: "en",
      rng: () => 0.999,
      clock: () => noonClock(),
    });
    expect(choice).toBeDefined();
    expect(["neutral", "noon"]).toContain(choice?.band);
  });

  it('lang: "en" with an injected corpus still returns no voiceClipId', () => {
    const choice = pickOpening({
      lang: "en",
      openings: {
        "001-test-only.txt": "preamble\n\n（我 说）\nseed\n（/我 说）\n",
      },
      rng: () => 0,
      clock: () => noonClock(),
    });
    expect(choice?.seedText).toBe("seed");
    expect(choice?.voiceClipId).toBeUndefined();
  });
});

describe("pickOpening (compiled corpus, M-prompts-1)", () => {
  // The corpus is an in-memory { filename: content } record — the default
  // is the compiled PROMPT_ASSETS.openings; tests inject their own.
  function corpus(
    entries: ReadonlyArray<readonly [string, string, string]>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [filename, preamble, seedText] of entries) {
      out[filename] = `${preamble}\n\n（我 说）\n${seedText}\n（/我 说）\n`;
    }
    return out;
  }

  function clockAtHour(hour: number): () => Date {
    const d = new Date("2026-05-16T00:00:00");
    d.setHours(hour);
    return () => d;
  }

  it("returns undefined for an empty corpus", () => {
    expect(pickOpening({ openings: {} })).toBeUndefined();
  });

  it("returns a parsed OpeningChoice for a single entry", () => {
    const result = pickOpening({
      openings: corpus([["001-test-only.txt", "preamble x", "seed y"]]),
      rng: () => 0,
      clock: clockAtHour(14),
    });
    expect(result).toBeDefined();
    expect(result?.preamble).toBe("preamble x");
    expect(result?.seedText).toBe("seed y");
    // sourceFile is the FILENAME (voice clipId pairs on the stem).
    expect(result?.sourceFile).toBe("001-test-only.txt");
    expect(result?.band).toBe("neutral");
  });

  it("filters out openings whose band conflicts with the current time", () => {
    const openings = corpus([
      ["016-dawn-first.txt", "dawn preamble", "dawn seed"],
      ["022-afternoon-drowsy.txt", "afternoon preamble", "afternoon seed"],
      ["002-neutral-one.txt", "neutral preamble", "neutral seed"],
    ]);
    const seenBands = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const r = pickOpening({
        openings,
        rng: () => i / 30,
        clock: clockAtHour(14),
      });
      if (r !== undefined) seenBands.add(r.band);
    }
    expect(seenBands.has("dawn")).toBe(false);
    expect(seenBands.has("afternoon") || seenBands.has("neutral")).toBe(true);
  });

  it("at 23:00 both midnight and late-night files are eligible", () => {
    const openings = corpus([
      ["028-midnight-quiet.txt", "midnight preamble", "midnight seed"],
      ["004-late-night-x.txt", "late-night preamble", "late-night seed"],
      ["016-dawn-x.txt", "dawn preamble", "dawn seed"],
    ]);
    const seenBands = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const r = pickOpening({
        openings,
        rng: () => i / 30,
        clock: clockAtHour(23),
      });
      if (r !== undefined) seenBands.add(r.band);
    }
    expect(seenBands.has("midnight")).toBe(true);
    expect(seenBands.has("late-night")).toBe(true);
    expect(seenBands.has("dawn")).toBe(false);
  });

  it("returns undefined when all entries conflict with current time", () => {
    const result = pickOpening({
      openings: corpus([["016-dawn-only.txt", "dawn preamble", "dawn seed"]]),
      rng: () => 0,
      clock: clockAtHour(14),
    });
    expect(result).toBeUndefined();
  });

  it("falls back to neutral when band-matching entries are absent", () => {
    const result = pickOpening({
      openings: corpus([
        ["002-neutral-fallback.txt", "neutral preamble", "neutral seed"],
      ]),
      rng: () => 0,
      clock: clockAtHour(6),
    });
    expect(result).toBeDefined();
    expect(result?.band).toBe("neutral");
  });

  it("skips malformed entries with a console.warn but uses valid ones", () => {
    const openings = {
      "001-malformed.txt": "this is not a valid opening file\n",
      ...corpus([["002-valid-neutral.txt", "valid preamble", "valid seed"]]),
    };
    const result = pickOpening({
      openings,
      rng: () => 0,
      clock: clockAtHour(14),
    });
    expect(result).toBeDefined();
    expect(result?.preamble).toBe("valid preamble");
  });

  it("uses injected rng to deterministically select an entry (sorted by filename)", () => {
    const openings = corpus([
      ["002-alpha.txt", "alpha", "alpha-seed"],
      ["002-beta.txt", "beta", "beta-seed"],
      ["002-gamma.txt", "gamma", "gamma-seed"],
    ]);
    const a = pickOpening({ openings, rng: () => 0, clock: clockAtHour(14) });
    const z = pickOpening({
      openings,
      rng: () => 0.99,
      clock: clockAtHour(14),
    });
    expect(a).toBeDefined();
    expect(z).toBeDefined();
    expect(a?.sourceFile).not.toBe(z?.sourceFile);
  });

  it("OpeningChoice includes the band tag", () => {
    const result = pickOpening({
      openings: corpus([["019-noon-test.txt", "noon preamble", "noon seed"]]),
      rng: () => 0,
      clock: clockAtHour(12),
    });
    expect(result?.band).toBe("noon");
  });

  it("only considers .txt keys (other extensions ignored)", () => {
    const openings = {
      ...corpus([["001-actual.txt", "preamble", "seed"]]),
      "001-actual.md": "not a txt",
      README: "not a txt",
    };
    const result = pickOpening({
      openings,
      rng: () => 0,
      clock: clockAtHour(14),
    });
    expect(result?.sourceFile.endsWith(".txt")).toBe(true);
  });

  it("smoke: the compiled default corpus yields a valid OpeningChoice", () => {
    expect(Object.keys(PROMPT_ASSETS.openings).length).toBeGreaterThanOrEqual(
      30,
    );
    const result = pickOpening({ rng: () => 0, clock: clockAtHour(14) });
    expect(result).toBeDefined();
    expect(result?.preamble.length).toBeGreaterThan(0);
    expect(result?.seedText.length).toBeGreaterThan(0);
    expect(result?.sourceFile.endsWith(".txt")).toBe(true);
  });
});
