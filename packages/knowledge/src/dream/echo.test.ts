import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalRecordBlock } from "@herta/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractHertaFenceLines, findEchoedRecords } from "./echo.js";
import type { DreamCreatedRecord, Episode } from "./types.js";

/** A distinctive （我 说） line — 19 non-whitespace chars incl. punctuation. */
const SPEECH_LINE = "这类事不值得再解释第二遍，尤其是对你。";
/** A distinctive （我 想） line. */
const THOUGHT_LINE = "他记住教训的速度比我预期的快一点点。";

const RECORD_FILE = "### 废案_01：回声测试.txt";
const RECORD_BODY = [
  "### 废案_01：回声测试",
  "开篇叙事，不参与匹配的散文。",
  "",
  "---",
  "",
  "（开拓者 说）",
  "这一句属于开拓者，绝不参与匹配的台词内容。",
  "（/开拓者 说）",
  "",
  "（我 说）",
  SPEECH_LINE,
  "（/我 说）",
  "",
  "（我 想）",
  THOUGHT_LINE,
  "（/我 想）",
  "",
].join("\n");

function mkRecord(extra: Partial<DreamCreatedRecord> = {}): DreamCreatedRecord {
  return {
    id: "rec-1",
    file: RECORD_FILE,
    nn: 1,
    state: "live",
    sourceSessionId: "s0",
    sourceEpisodeHash: "hBirth",
    sourceEpisodes: ["hBirth"],
    runId: "r0",
    model: "m",
    generatedAt: "2026-06-01T00:00:00Z",
    situationTag: "tag",
    summary: "摘要",
    critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
    validateFeianPassed: true,
    reactivationCount: 0,
    ...extra,
  };
}

function mkEpisode(
  blocks: readonly TerminalRecordBlock[],
  extra: Partial<Episode> = {},
): Episode {
  return {
    sessionId: "s1",
    episodeHash: "hEp",
    blocks,
    startIndex: 0,
    endIndex: blocks.length,
    settled: true,
    ...extra,
  };
}

const speech = (text: string): TerminalRecordBlock => ({
  kind: "herta",
  surface: "speech",
  text,
});
const thought = (text: string): TerminalRecordBlock => ({
  kind: "herta",
  surface: "thought",
  text,
});
const user = (text: string): TerminalRecordBlock => ({ kind: "user", text });

describe("extractHertaFenceLines", () => {
  it("extracts speech AND thought content, never other roles or prose", () => {
    const lines = extractHertaFenceLines(RECORD_BODY);
    expect(lines).toEqual([SPEECH_LINE, THOUGHT_LINE]);
  });

  it("tolerates an unclosed fence (EOF closes it, content kept)", () => {
    const body = [
      "### 废案_02：未闭合",
      "叙事。",
      "",
      "（我 说）",
      SPEECH_LINE,
    ].join("\n");
    expect(extractHertaFenceLines(body)).toEqual([SPEECH_LINE]);
  });

  it("another role's opener closes a dangling 我-fence", () => {
    const body = [
      "（我 说）",
      SPEECH_LINE,
      "（开拓者 说）",
      "开拓者的这一句不得被收进黑塔的台词。",
      "（/开拓者 说）",
    ].join("\n");
    expect(extractHertaFenceLines(body)).toEqual([SPEECH_LINE]);
  });
});

describe("findEchoedRecords", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dream-echo-"));
    writeFileSync(join(dir, RECORD_FILE), RECORD_BODY, "utf8");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("matches on a contiguous run of exactly minChars from a （我 说） line", () => {
    // "这类事不值得再解释第二遍" — exactly 12 non-whitespace chars.
    const ep = mkEpisode([
      user("你之前说过什么来着"),
      speech("我说过：这类事不值得再解释第二遍。剩下的自己想。"),
    ]);
    const hits = findEchoedRecords(ep, [mkRecord()], dir, 12);
    expect(hits.map((r) => r.id)).toEqual(["rec-1"]);
  });

  it("does NOT match when only a shorter-than-minChars run is shared", () => {
    // Shares "这类事不值得再解释第二" (11 chars) but no 12-char record window.
    const ep = mkEpisode([
      speech("有人问我这类事不值得再解释第二次吗，我懒得答。"),
    ]);
    expect(findEchoedRecords(ep, [mkRecord()], dir, 12)).toEqual([]);
  });

  it("whitespace-stripping catches a phrase wrapped across lines in the episode", () => {
    const ep = mkEpisode([
      speech("这类事不值得再解释\n第二遍，你自己心里有数。"),
    ]);
    expect(findEchoedRecords(ep, [mkRecord()], dir, 12)).toHaveLength(1);
  });

  it("skips a record born from the SAME session (self-echo guard)", () => {
    const ep = mkEpisode([speech(SPEECH_LINE)], { sessionId: "s0" });
    expect(findEchoedRecords(ep, [mkRecord()], dir, 12)).toEqual([]);
  });

  it("skips a record this episode already contributed to (episodeHash guard)", () => {
    const rec = mkRecord({ sourceEpisodes: ["hBirth", "hEp"] });
    const ep = mkEpisode([speech(SPEECH_LINE)]);
    expect(findEchoedRecords(ep, [rec], dir, 12)).toEqual([]);
  });

  it("a （我 想） record line echoed in an episode THOUGHT block matches", () => {
    const ep = mkEpisode([
      user("在忙？"),
      thought(`又来了。${THOUGHT_LINE}这次姑且多看两眼。`),
      speech("在。说重点。"),
    ]);
    expect(findEchoedRecords(ep, [mkRecord()], dir, 12)).toHaveLength(1);
  });

  it("user and system blocks never contribute to the episode side", () => {
    const ep = mkEpisode([
      user(`你上次不是说"${SPEECH_LINE}"吗`),
      speech("我说过很多话。"),
    ]);
    expect(findEchoedRecords(ep, [mkRecord()], dir, 12)).toEqual([]);
  });

  it("matches a record whose only fence is unclosed (tolerant parse end-to-end)", () => {
    const file = "### 废案_02：未闭合.txt";
    writeFileSync(
      join(dir, file),
      [
        "### 废案_02：未闭合",
        "叙事。",
        "",
        "---",
        "",
        "（我 说）",
        SPEECH_LINE,
      ].join("\n"),
      "utf8",
    );
    const rec = mkRecord({ id: "rec-2", file });
    const ep = mkEpisode([speech(`我提醒过：${SPEECH_LINE}`)]);
    expect(findEchoedRecords(ep, [rec], dir, 12).map((r) => r.id)).toEqual([
      "rec-2",
    ]);
  });

  it("a missing record file contributes nothing (no crash)", () => {
    const rec = mkRecord({ id: "gone", file: "### 废案_09：不存在.txt" });
    const ep = mkEpisode([speech(SPEECH_LINE)]);
    expect(findEchoedRecords(ep, [rec], dir, 12)).toEqual([]);
  });

  it("minChars ≤ 0 disables the stage", () => {
    const ep = mkEpisode([speech(SPEECH_LINE)]);
    expect(findEchoedRecords(ep, [mkRecord()], dir, 0)).toEqual([]);
  });
});
