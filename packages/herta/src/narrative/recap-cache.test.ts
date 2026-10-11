import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteRecapCache,
  readRecapCache,
  writeRecapCache,
} from "./recap-cache.js";

describe("recap cache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "recap-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cache = {
    boundaryIndex: 12,
    recapText: "回忆",
    lang: "zh",
    advancesSinceRederive: 2,
  } as const;

  it("round-trips and leaves no temp residue", () => {
    writeRecapCache(dir, "sess1", cache);
    expect(readRecapCache(dir, "sess1")).toEqual(cache);
    expect(
      readdirSync(join(dir, ".herta", "compaction")).some((f) =>
        f.includes(".tmp"),
      ),
    ).toBe(false);
  });

  it("returns null for a missing or corrupt file", () => {
    expect(readRecapCache(dir, "nope")).toBeNull();
    writeRecapCache(dir, "sess1", cache); // ensures the dir exists
    writeFileSync(
      join(dir, ".herta", "compaction", "sess1.json"),
      "{ bad",
      "utf8",
    );
    expect(readRecapCache(dir, "sess1")).toBeNull();
  });

  it("coerces missing optional fields to defaults", () => {
    mkdirSync(join(dir, ".herta", "compaction"), { recursive: true });
    writeFileSync(
      join(dir, ".herta", "compaction", "sess2.json"),
      JSON.stringify({ boundaryIndex: 5, recapText: "x" }),
      "utf8",
    );
    expect(readRecapCache(dir, "sess2")).toEqual({
      boundaryIndex: 5,
      recapText: "x",
      lang: "zh",
      advancesSinceRederive: 0,
    });
  });

  it("reads a legacy pre-lang sidecar (dead model field) as zh", () => {
    mkdirSync(join(dir, ".herta", "compaction"), { recursive: true });
    writeFileSync(
      join(dir, ".herta", "compaction", "legacy.json"),
      JSON.stringify({
        boundaryIndex: 8,
        recapText: "旧版存档",
        model: "router",
        advancesSinceRederive: 3,
      }),
      "utf8",
    );
    expect(readRecapCache(dir, "legacy")).toEqual({
      boundaryIndex: 8,
      recapText: "旧版存档",
      lang: "zh",
      advancesSinceRederive: 3,
    });
  });

  it("returns null for a non-object JSON value", () => {
    mkdirSync(join(dir, ".herta", "compaction"), { recursive: true });
    writeFileSync(
      join(dir, ".herta", "compaction", "sess3.json"),
      "42",
      "utf8",
    );
    expect(readRecapCache(dir, "sess3")).toBeNull();
  });

  it("deleteRecapCache removes the sidecar; missing file is a no-op", () => {
    writeRecapCache(dir, "sess1", cache);
    const file = join(dir, ".herta", "compaction", "sess1.json");
    expect(existsSync(file)).toBe(true);
    deleteRecapCache(dir, "sess1");
    expect(existsSync(file)).toBe(false);
    expect(readRecapCache(dir, "sess1")).toBeNull();
    expect(() => deleteRecapCache(dir, "sess1")).not.toThrow();
    expect(() => deleteRecapCache(dir, "never-existed")).not.toThrow();
  });
});
