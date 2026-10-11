import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadClipStems,
  pickClipStem,
  pickClipStemAvoiding,
} from "./clip-list.js";

describe("loadClipStems", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("lists *.opus stems, sorted, ignoring non-opus and subdirs", async () => {
    dir = mkdtempSync(join(tmpdir(), "veto-"));
    writeFileSync(join(dir, "等等，我得再改一改。.opus"), "x");
    writeFileSync(join(dir, "先别急呀，让我重新编辑一下。.opus"), "x");
    writeFileSync(join(dir, "readme.txt"), "x"); // non-clip ignored
    // A .wav master beside its .opus (the dev-tree layout since the
    // 2026-07-16 cutover) must NOT duplicate the stem.
    writeFileSync(join(dir, "等等，我得再改一改。.wav"), "x");
    mkdirSync(join(dir, "nested")); // subdir ignored
    const stems = await loadClipStems(dir);
    expect(stems).toEqual(
      ["先别急呀，让我重新编辑一下。", "等等，我得再改一改。"].sort(),
    );
  });

  it("returns an empty list for a missing directory", async () => {
    const stems = await loadClipStems(join(tmpdir(), "no-such-veto-xyz"));
    expect(stems).toEqual([]);
  });
});

describe("pickClipStem", () => {
  const stems = ["a", "b", "c"];

  it("picks a stem within range (low and high random)", () => {
    expect(pickClipStem(stems, () => 0)).toBe("a");
    expect(pickClipStem(stems, () => 0.99)).toBe("c"); // clamped to last
  });

  it("returns null for an empty list", () => {
    expect(pickClipStem([], () => 0.5)).toBeNull();
  });
});

describe("pickClipStemAvoiding", () => {
  const stems = ["a", "b", "c"];

  it("never returns the avoided clip when there are alternatives", () => {
    // avoid "a" → pool ["b","c"]
    expect(pickClipStemAvoiding(stems, () => 0, "a")).toBe("b");
    expect(pickClipStemAvoiding(stems, () => 0.99, "a")).toBe("c");
    // avoid the middle one → pool ["a","c"]
    expect(pickClipStemAvoiding(stems, () => 0, "b")).toBe("a");
    expect(pickClipStemAvoiding(stems, () => 0.99, "b")).toBe("c");
  });

  it("behaves like pickClipStem when avoid is null", () => {
    expect(pickClipStemAvoiding(stems, () => 0, null)).toBe("a");
    expect(pickClipStemAvoiding(stems, () => 0.99, null)).toBe("c");
  });

  it("ignores an avoid that is not among the stems", () => {
    expect(pickClipStemAvoiding(stems, () => 0, "z")).toBe("a");
  });

  it("returns the only clip even if it is the avoided one (repeat unavoidable)", () => {
    expect(pickClipStemAvoiding(["x"], () => 0.5, "x")).toBe("x");
  });

  it("returns null for an empty list", () => {
    expect(pickClipStemAvoiding([], () => 0.5, "a")).toBeNull();
  });

  it("never repeats the previous pick across consecutive calls", () => {
    let last: string | null = null;
    const picks: string[] = [];
    for (let n = 0; n < 4; n++) {
      const pick = pickClipStemAvoiding(stems, () => 0, last);
      expect(pick).not.toBe(last);
      if (pick !== null) {
        picks.push(pick);
        last = pick;
      }
    }
    expect(picks).toEqual(["a", "b", "a", "b"]);
  });
});
