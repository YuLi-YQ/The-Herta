import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSessionFiles } from "@herta/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteRecapCache,
  readRecapCache,
  writeRecapCache,
} from "./recap-cache.js";

let root: string;
const links: string[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herta-recap-guard-"));
});
afterEach(() => {
  for (const link of links.splice(0)) unlinkSync(link);
  rmSync(root, { recursive: true, force: true });
});
const cache = {
  boundaryIndex: 2,
  recapText: "Synthetic summary",
  lang: "en",
  advancesSinceRederive: 0,
  generatedAt: "2026-11-01T00:00:00.000Z",
} as const;
describe("recap application-storage guards", () => {
  it.each([
    ".herta",
    ".herta/compaction",
  ])("does not read, write, or delete through a linked %s", async (segment) => {
    const destination = join(root, "external");
    mkdirSync(destination);
    writeFileSync(join(destination, "s.json"), JSON.stringify(cache));
    if (segment.includes("/")) mkdirSync(join(root, ".herta"));
    const link = join(root, segment);
    symlinkSync(destination, link, "junction");
    links.push(link);
    expect(readRecapCache(root, "s")).toBeNull();
    expect(() => writeRecapCache(root, "s", cache)).toThrow();
    expect(() => deleteRecapCache(root, "s")).toThrow("Unsafe recap directory");
    mkdirSync(join(root, "transcripts"));
    writeFileSync(join(root, "transcripts", "s.jsonl"), "original transcript");
    await expect(
      deleteSessionFiles(join(root, "transcripts"), "s", undefined, root),
    ).rejects.toThrow("Unsafe recap directory");
    expect(readFileSync(join(root, "transcripts", "s.jsonl"), "utf8")).toBe(
      "original transcript",
    );
    expect(readFileSync(join(destination, "s.json"), "utf8")).toBe(
      JSON.stringify(cache),
    );
    expect(readdirSync(destination)).toEqual(["s.json"]);
  });
  it("rejects traversal and oversized input; preserves malformed bytes", () => {
    expect(() => writeRecapCache(root, "../escape", cache)).toThrow();
    expect(existsSync(join(root, ".herta"))).toBe(false);
    writeRecapCache(root, "s", cache);
    expect(readRecapCache(root, "s")).toEqual(cache);
    const file = join(root, ".herta", "compaction", "s.json");
    writeFileSync(file, "broken");
    expect(readRecapCache(root, "s")).toBeNull();
    expect(readFileSync(file, "utf8")).toBe("broken");
    writeFileSync(file, "x".repeat(2 * 1024 * 1024 + 1));
    expect(readRecapCache(root, "s")).toBeNull();
    expect(() =>
      writeRecapCache(root, "s", {
        ...cache,
        recapText: "x".repeat(2 * 1024 * 1024),
      }),
    ).toThrow();
  });
});
