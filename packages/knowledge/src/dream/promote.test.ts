import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveLiveRecord,
  assertUnderDreamRoot,
  promoteCandidate,
} from "./promote.js";

describe("promote", () => {
  let ws: string;
  let narrative: string;
  let dreamDir: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "dream-promote-"));
    narrative = join(ws, ".herta", "narrative");
    dreamDir = join(ws, ".herta", "dream");
    mkdirSync(narrative, { recursive: true });
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it("writes a 废案 atomically with the next NN and returns its filename", () => {
    writeFileSync(join(narrative, "### 废案_00：seed.txt"), "x");
    const r = promoteCandidate({
      narrativeDir: narrative,
      dreamDir,
      title: "新案",
      feianBody: "### 废案_00：新案\n正文\n---\n（我 说）\n好。\n（/我 说）",
      runId: "r1",
    });
    expect(r.nn).toBe(1);
    expect(r.file).toBe("### 废案_01：新案.txt");
    expect(existsSync(join(narrative, r.file))).toBe(true);
    // header rewritten to the assigned NN
    expect(
      readdirSync(narrative).filter((f) => f.startsWith(".dream-tmp")),
    ).toHaveLength(0);
  });

  it("archiveLiveRecord moves the file to dream/archive (never deletes)", () => {
    writeFileSync(join(narrative, "### 废案_01：x.txt"), "body");
    archiveLiveRecord({
      narrativeDir: narrative,
      dreamDir,
      file: "### 废案_01：x.txt",
      reason: "evicted",
    });
    expect(existsSync(join(narrative, "### 废案_01：x.txt"))).toBe(false);
    expect(existsSync(join(dreamDir, "archive", "### 废案_01：x.txt"))).toBe(
      true,
    );
  });

  it("a second archived file with an archived one's exact name never overwrites it (dream review 2026-09-22, finding 19)", () => {
    const name = "### 废案_01：x.txt";
    writeFileSync(join(narrative, name), "the first memory");
    expect(
      archiveLiveRecord({
        narrativeDir: narrative,
        dreamDir,
        file: name,
        reason: "a",
      }),
    ).toBe(name);
    // A later 废案 takes the same NN and title, then is archived in turn.
    writeFileSync(join(narrative, name), "the second memory");
    expect(
      archiveLiveRecord({
        narrativeDir: narrative,
        dreamDir,
        file: name,
        reason: "b",
      }),
    ).toBe("### 废案_01：x (2).txt");
    const archive = join(dreamDir, "archive");
    expect(readFileSync(join(archive, name), "utf8")).toBe("the first memory");
    expect(readFileSync(join(archive, "### 废案_01：x (2).txt"), "utf8")).toBe(
      "the second memory",
    );
  });

  describe("assertUnderDreamRoot", () => {
    it("allows a path that is inside root", () => {
      expect(() => assertUnderDreamRoot("/a/b/c", "/a/b")).not.toThrow();
    });

    it("throws for a path outside root", () => {
      expect(() => assertUnderDreamRoot("/a/x", "/a/b")).toThrow(
        /dream: refusing to write outside/,
      );
    });
  });

  it("sanitizes slashed title in filename but keeps original in header", () => {
    const r = promoteCandidate({
      narrativeDir: narrative,
      dreamDir,
      title: "macOS/Linux 的对比",
      feianBody: "### 废案_00：macOS/Linux 的对比\n正文",
      runId: "r2",
    });
    // filename must not contain /
    expect(r.file).not.toContain("/");
    expect(r.file).toContain("_");
    expect(existsSync(join(narrative, r.file))).toBe(true);
    // internal header must retain original title with /
    const content = readFileSync(join(narrative, r.file), "utf8");
    expect(content.split("\n")[0]).toBe(
      `### 废案_${String(r.nn).padStart(2, "0")}：macOS/Linux 的对比`,
    );
  });

  it("header rewrite: body with 旧名 header gets rewritten to assigned NN + promote title", () => {
    writeFileSync(join(narrative, "### 废案_00：seed.txt"), "x");
    const r = promoteCandidate({
      narrativeDir: narrative,
      dreamDir,
      title: "新名",
      feianBody: "### 废案_00：旧名\n正文内容",
      runId: "r3",
    });
    const content = readFileSync(join(narrative, r.file), "utf8");
    expect(content.split("\n")[0]).toBe(
      `### 废案_${String(r.nn).padStart(2, "0")}：新名`,
    );
  });

  it("NN=0 from empty narrativeDir: promotes to ### 废案_00：<title>.txt", () => {
    // narrativeDir is empty (no seed files created in beforeEach)
    const r = promoteCandidate({
      narrativeDir: narrative,
      dreamDir,
      title: "第一案",
      feianBody: "### 废案：第一案\n正文",
      runId: "r4",
    });
    expect(r.nn).toBe(0);
    expect(r.file).toBe("### 废案_00：第一案.txt");
    expect(existsSync(join(narrative, r.file))).toBe(true);
  });
});
