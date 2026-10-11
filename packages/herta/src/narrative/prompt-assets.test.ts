import { describe, expect, it } from "vitest";
import { PROMPT_ASSETS, PROMPT_ASSETS_EN } from "./prompt-assets.generated.js";
import { promptAssetsFor } from "./prompt-assets.js";

describe("promptAssetsFor (slice 4)", () => {
  it("zh returns the exact PROMPT_ASSETS object (default identity)", () => {
    expect(promptAssetsFor("zh")).toBe(PROMPT_ASSETS);
  });

  it("en returns the exact PROMPT_ASSETS_EN object", () => {
    expect(promptAssetsFor("en")).toBe(PROMPT_ASSETS_EN);
  });

  it("the two bundles are distinct objects with distinct top-level prose", () => {
    expect(PROMPT_ASSETS_EN).not.toBe(PROMPT_ASSETS);
    expect(PROMPT_ASSETS_EN.hertaBio).not.toBe(PROMPT_ASSETS.hertaBio);
    expect(PROMPT_ASSETS_EN.envSet).not.toBe(PROMPT_ASSETS.envSet);
    expect(PROMPT_ASSETS_EN.hertaGuide).not.toBe(PROMPT_ASSETS.hertaGuide);
    expect(PROMPT_ASSETS_EN.hertaBio.length).toBeGreaterThan(0);
    expect(PROMPT_ASSETS_EN.envSet.length).toBeGreaterThan(0);
    expect(PROMPT_ASSETS_EN.hertaGuide.length).toBeGreaterThan(0);
  });

  it("key sets are identical in every record group (codegen parity gate)", () => {
    // Mirrors the codegen's fail-loudly check so a hand-edit of the
    // generated file cannot silently break parity either.
    const keysOf = (r: Readonly<Record<string, string>>): string[] =>
      Object.keys(r).sort();
    expect(keysOf(PROMPT_ASSETS_EN.hints)).toEqual(keysOf(PROMPT_ASSETS.hints));
    expect(keysOf(PROMPT_ASSETS_EN.metaThink.preThink)).toEqual(
      keysOf(PROMPT_ASSETS.metaThink.preThink),
    );
    expect(keysOf(PROMPT_ASSETS_EN.metaThink.preSpeak)).toEqual(
      keysOf(PROMPT_ASSETS.metaThink.preSpeak),
    );
    expect(keysOf(PROMPT_ASSETS_EN.openings)).toEqual(
      keysOf(PROMPT_ASSETS.openings),
    );
    expect(keysOf(PROMPT_ASSETS_EN.feianSeeds)).toEqual(
      keysOf(PROMPT_ASSETS.feianSeeds),
    );
  });

  it("MoodState keys stay the CN filenames in BOTH bundles (machine contract)", () => {
    for (const bundle of [PROMPT_ASSETS, PROMPT_ASSETS_EN]) {
      expect(Object.keys(bundle.metaThink.preThink)).toContain("默认");
      expect(Object.keys(bundle.metaThink.preSpeak)).toContain("板砖代答版");
    }
  });
});
