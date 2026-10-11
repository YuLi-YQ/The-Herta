import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadParticleCatalog,
  matchLeadingParticle,
  type ParticleCatalog,
  pickParticleClip,
} from "./particle-catalog.js";

/** Build an in-memory catalog from token→variants, tokens sorted longest-first
 *  (as loadParticleCatalog produces). */
function catalogOf(
  entries: Record<string, readonly string[]>,
): ParticleCatalog {
  const variants = new Map<string, readonly string[]>(Object.entries(entries));
  const tokens = [...variants.keys()].sort((a, b) => b.length - a.length);
  return { tokens, variants };
}

const FULL = catalogOf({
  哎呀: ["01", "02"],
  "嗯？": ["01", "02", "03"],
  "啊？": ["01"],
  "哈？": ["01"],
  嗯: ["01", "02", "03", "04"],
  啊: ["01"],
  哦: ["01"],
  哎: ["01"],
  哼: ["01"],
});

describe("matchLeadingParticle", () => {
  it("matches a leading particle followed by a boundary", () => {
    expect(matchLeadingParticle("嗯，你来了", FULL)).toBe("嗯");
    expect(matchLeadingParticle("啊，原来如此", FULL)).toBe("啊");
    expect(matchLeadingParticle("哦。明白了", FULL)).toBe("哦");
  });

  it("prefers the longest token (哎呀＞哎, 嗯？＞嗯)", () => {
    expect(matchLeadingParticle("哎呀，糟糕", FULL)).toBe("哎呀");
    expect(matchLeadingParticle("嗯？真的吗", FULL)).toBe("嗯？");
  });

  it("treats a ？-token as self-delimiting (no boundary needed after)", () => {
    expect(matchLeadingParticle("哈？你说什么", FULL)).toBe("哈？");
  });

  it("matches a particle that is the whole text (end-of-string boundary)", () => {
    expect(matchLeadingParticle("嗯", FULL)).toBe("嗯");
    expect(matchLeadingParticle("哎呀", FULL)).toBe("哎呀");
  });

  it("does NOT match a particle char that starts a longer word", () => {
    expect(matchLeadingParticle("嗯哼，骗人", FULL)).toBeNull();
    expect(matchLeadingParticle("哦豁", FULL)).toBeNull();
  });

  it("does NOT match a particle that isn't at the start", () => {
    expect(matchLeadingParticle("你好，嗯，在的", FULL)).toBeNull();
    expect(matchLeadingParticle("真的吗？嗯", FULL)).toBeNull();
  });

  it("does NOT match a token absent from the catalog (哈 exists only as 哈？)", () => {
    expect(matchLeadingParticle("哈，好吧", FULL)).toBeNull();
  });

  it("returns null for empty text and an empty catalog", () => {
    expect(matchLeadingParticle("", FULL)).toBeNull();
    expect(
      matchLeadingParticle("嗯，你来了", { tokens: [], variants: new Map() }),
    ).toBeNull();
  });
});

describe("pickParticleClip", () => {
  it("returns category particle/<token> and a variant within range", () => {
    expect(pickParticleClip(FULL, "嗯", () => 0)).toEqual({
      category: "particle/嗯",
      clipId: "01",
    });
    // random→0.99 selects the last of 4 variants.
    expect(pickParticleClip(FULL, "嗯", () => 0.99)).toEqual({
      category: "particle/嗯",
      clipId: "04",
    });
  });

  it("returns null for an unknown or variant-less token", () => {
    expect(pickParticleClip(FULL, "唉", () => 0)).toBeNull();
    expect(pickParticleClip(catalogOf({ 嗯: [] }), "嗯", () => 0)).toBeNull();
  });
});

describe("loadParticleCatalog", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function writeToken(root: string, token: string, variants: string[]): void {
    const d = join(root, token);
    mkdirSync(d, { recursive: true });
    for (const v of variants) writeFileSync(join(d, `${v}.opus`), "x");
  }

  it("reads tokens + variant stems, sorted longest-first", async () => {
    dir = mkdtempSync(join(tmpdir(), "particle-"));
    writeToken(dir, "嗯", ["01", "02"]);
    writeToken(dir, "哎呀", ["01"]);
    const cat = await loadParticleCatalog(dir);
    expect(cat.tokens).toEqual(["哎呀", "嗯"]); // 2-char before 1-char
    expect(cat.variants.get("嗯")).toEqual(["01", "02"]);
    expect(cat.variants.get("哎呀")).toEqual(["01"]);
  });

  it("skips a token dir with no wav files and ignores stray files", async () => {
    dir = mkdtempSync(join(tmpdir(), "particle-"));
    writeToken(dir, "嗯", ["01"]);
    mkdirSync(join(dir, "empty"), { recursive: true });
    writeFileSync(join(dir, "嗯", "readme.txt"), "x"); // non-wav ignored
    writeFileSync(join(dir, "loose.opus"), "x"); // file at root, not a token dir
    const cat = await loadParticleCatalog(dir);
    expect(cat.tokens).toEqual(["嗯"]);
    expect(cat.variants.get("嗯")).toEqual(["01"]);
  });

  it("returns an empty catalog for a missing directory", async () => {
    const cat = await loadParticleCatalog(
      join(tmpdir(), "does-not-exist-particle-xyz"),
    );
    expect(cat.tokens).toEqual([]);
    expect(cat.variants.size).toBe(0);
  });
});
