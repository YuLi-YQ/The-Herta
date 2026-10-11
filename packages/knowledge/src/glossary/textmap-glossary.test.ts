import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTextMap, searchAlignedTerms } from "./textmap-glossary.js";

const CN: Record<string, string> = {
  "100": "大黑塔",
  "200": "「大黑塔」回来了，小鬼们都安静点。",
  "300": "星核小鬼——粉毛的小矮子——",
  "400": "黑塔",
  "500": "", // empty rows exist in real maps — never a hit
  "600": "只在中文侧存在的行",
};

const EN: Record<string, string> = {
  "100": "The Herta",
  "200": "The Herta is back. Quiet down, you lot.",
  "300": "You there, Stellaron twerp and little miss pink...",
  "400": "Herta",
  "500": "",
  // "600" deliberately missing — CN-only row
};

describe("searchAlignedTerms", () => {
  it("returns aligned CN/EN pairs for a CN substring, shortest first", () => {
    const hits = searchAlignedTerms(CN, EN, "大黑塔");
    expect(hits.map((h) => h.hash)).toEqual(["100", "200"]);
    expect(hits[0]).toEqual({ hash: "100", cn: "大黑塔", en: "The Herta" });
  });

  it("exact match returns only the full-string entry", () => {
    const hits = searchAlignedTerms(CN, EN, "黑塔", { exact: true });
    expect(hits).toEqual([{ hash: "400", cn: "黑塔", en: "Herta" }]);
  });

  it("searches the EN side case-insensitively when side=en", () => {
    const hits = searchAlignedTerms(CN, EN, "stellaron TWERP", { side: "en" });
    expect(hits.map((h) => h.hash)).toEqual(["300"]);
    expect(hits[0]?.cn).toContain("星核小鬼");
  });

  it("keeps a CN-only row, with en undefined", () => {
    const hits = searchAlignedTerms(CN, EN, "只在中文侧");
    expect(hits).toEqual([
      { hash: "600", cn: "只在中文侧存在的行", en: undefined },
    ]);
  });

  it("honors limit and never matches empty rows", () => {
    expect(searchAlignedTerms(CN, EN, "黑塔", { limit: 1 })).toHaveLength(1);
    expect(searchAlignedTerms(CN, EN, "")).not.toContainEqual(
      expect.objectContaining({ hash: "500" }),
    );
  });
});

describe("loadTextMap", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(
      tmpdir(),
      `herta-textmap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("loads a flat hash→string object", () => {
    const p = join(dir, "TextMapCHS.json");
    writeFileSync(p, JSON.stringify(CN), "utf8");
    expect(loadTextMap(p)["100"]).toBe("大黑塔");
  });

  it("rejects a non-object file loudly", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, JSON.stringify(["not", "a", "map"]), "utf8");
    expect(() => loadTextMap(p)).toThrow(/not a TextMap/);
  });
});
