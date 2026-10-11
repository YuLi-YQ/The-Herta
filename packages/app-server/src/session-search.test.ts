import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  brickQueryVariant,
  narrowSearchCandidates,
  rawPrefilterNeedle,
  SEARCH_MEMO_MAX_AGE_MS,
  type SearchMemo,
  searchSessionTranscripts,
  snippetAround,
} from "./session-search.js";
import type { SessionMetadata } from "./types.js";

describe("snippetAround", async () => {
  it("matches case-insensitively and windows around the match", async () => {
    const s = snippetAround(
      "The parser bug lives in the cursor reset",
      "PARSER",
    );
    expect(s).toBe("The parser bug lives in the cursor reset");
  });

  it("returns null when the query does not occur", async () => {
    expect(snippetAround("nothing here", "parser")).toBeNull();
  });

  it("collapses whitespace so multi-line blocks read as one preview line", async () => {
    expect(snippetAround("first line\n\n  second\tline", "second")).toBe(
      "first line second line",
    );
  });

  it("windows a match deep in a long text with ellipses on both sides", async () => {
    const text = `${"填".repeat(40)}目标词${"充".repeat(80)}`;
    const s = snippetAround(text, "目标词");
    expect(s).not.toBeNull();
    expect(s?.startsWith("…")).toBe(true);
    expect(s?.endsWith("…")).toBe(true);
    expect(s).toContain("目标词");
    // 12 lead-in code points + the ellipsis marker.
    expect(s?.indexOf("目标词")).toBe(13);
  });

  it("windows by code points — an astral-plane text never slices a surrogate", async () => {
    const text = `${"🌌".repeat(30)}quasar${"🌠".repeat(30)}`;
    const s = snippetAround(text, "quasar") ?? "";
    expect(s).toContain("quasar");
    // Every non-ASCII char in the snippet must still be a whole emoji.
    for (const c of s) {
      expect(["🌌", "🌠", "…"].includes(c) || /[a-z]/.test(c)).toBe(true);
    }
  });
});

describe("searchSessionTranscripts", async () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "herta-search-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSession(
    sessionId: string,
    blocks: readonly Record<string, unknown>[],
  ): SessionMetadata {
    const header = JSON.stringify({
      _kind: "session_meta",
      version: 1,
      sessionId,
      startedAt: "2026-07-11T00:00:00.000Z",
      workspaceRoot: "/repo",
    });
    const lines = [header, ...blocks.map((b) => JSON.stringify(b))];
    writeFileSync(join(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
    return {
      sessionId,
      workspaceRoot: "/repo",
      startedAt: "2026-07-11T00:00:00.000Z",
      lastActivityAt: "2026-07-11T00:00:00.000Z",
    };
  }

  // ── blockIndex: where the click should land (2026-07-27) ───────────────

  it("reports the matched block's ABSOLUTE record index, skipping meta lines", async () => {
    const s = writeSession("s-idx", [
      { kind: "user", text: "第一问" }, // 0
      { kind: "herta", surface: "speech", text: "第一答" }, // 1
      { kind: "user", text: "第二问 needle 在这里" }, // 2
    ]);
    const hits = await searchSessionTranscripts({
      transcriptDir: dir,
      sessions: [s],
      query: "needle",
    });
    // The session_meta header is NOT a record block — readSessionFile skips
    // it when building the record, so the index must too.
    expect(hits[0]?.blockIndex).toBe(2);
  });

  it("meta lines interleaved mid-file do not shift the index", async () => {
    const s = writeSession("s-meta", [
      { kind: "user", text: "一" }, // 0
      { _kind: "workspace_set", path: "/repo/sub" }, // not a block
      { kind: "herta", surface: "speech", text: "二" }, // 1
      { _kind: "turn_end", outcome: "completed", at: "t" }, // not a block
      { kind: "user", text: "三 needle" }, // 2
    ]);
    const hits = await searchSessionTranscripts({
      transcriptDir: dir,
      sessions: [s],
      query: "needle",
    });
    expect(hits[0]?.blockIndex).toBe(2);
  });

  it("a HERTA-speech match anchors to the user turn that opened the exchange", async () => {
    // Only user rows carry `data-abs-index` (the topic rail's jump relies on
    // the same anchor), and landing on the question with the answer below it
    // reads better than landing mid-answer.
    const s = writeSession("s-herta", [
      { kind: "user", text: "无关的一问" }, // 0
      { kind: "herta", surface: "speech", text: "无关的一答" }, // 1
      { kind: "user", text: "解析器怎么了" }, // 2  ← anchor
      { kind: "herta", surface: "speech", text: "游标 needle 没复位" }, // 3
    ]);
    const hits = await searchSessionTranscripts({
      transcriptDir: dir,
      sessions: [s],
      query: "needle",
    });
    expect(hits[0]?.snippet).toContain("needle");
    expect(hits[0]?.blockIndex).toBe(2);
  });

  it("a match before any user block is DROPPED, not anchored to itself (audit BL13)", async () => {
    // It used to anchor to itself — index 0, the canned opening. The
    // conversation stamps `data-abs-index` on USER rows only, so that anchor
    // row can never materialize: jumpToTopic unpins, waits for a row that
    // will not appear, and strands the reader with no fallback. The opening
    // is a fixed greeting; a hit on it is not worth a broken jump.
    const s = writeSession("s-open", [
      { kind: "herta", surface: "speech", text: "开场白 needle" }, // 0
      { kind: "user", text: "你好" }, // 1
    ]);
    const hits = await searchSessionTranscripts({
      transcriptDir: dir,
      sessions: [s],
      query: "needle",
    });
    expect(hits).toEqual([]);
  });

  it("a LATER Herta match still anchors to the user block that opened it", async () => {
    const s = writeSession("s-later", [
      { kind: "herta", surface: "speech", text: "开场白" }, // 0
      { kind: "user", text: "你好" }, // 1
      { kind: "herta", surface: "speech", text: "带 needle 的回答" }, // 2
    ]);
    const hits = await searchSessionTranscripts({
      transcriptDir: dir,
      sessions: [s],
      query: "needle",
    });
    expect(hits[0]?.blockIndex).toBe(1);
  });

  it("matches user blocks and Herta speech, one hit per session, newest order kept", async () => {
    const a = writeSession("s-a", [
      { kind: "user", text: "修一下 parser 的 bug" },
      { kind: "herta", surface: "speech", text: "看看。parser 的游标没复位。" },
    ]);
    const b = writeSession("s-b", [
      { kind: "user", text: "今天天气如何" },
      { kind: "herta", surface: "speech", text: "我是黑塔，不是气象站。" },
    ]);
    const hits = await searchSessionTranscripts({
      transcriptDir: dir,
      sessions: [a, b],
      query: "parser",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.sessionId).toBe("s-a");
    // First matching block wins (the user block, not Herta's reply).
    expect(hits[0]?.snippet).toContain("修一下 parser 的 bug");

    const speechHits = await searchSessionTranscripts({
      transcriptDir: dir,
      sessions: [a, b],
      query: "气象站",
    });
    expect(speechHits.map((h) => h.sessionId)).toEqual(["s-b"]);
  });

  it("ignores thought, system, and meta content (the card could not show the match)", async () => {
    const s = writeSession("s-thought", [
      { kind: "herta", surface: "thought", text: "quantum in a thought" },
      { kind: "system", label: "差分协处理器", body: "quantum in a body" },
      { kind: "herta", surface: "speech", text: "别的话。" },
    ]);
    expect(
      await searchSessionTranscripts({
        transcriptDir: dir,
        sessions: [s],
        query: "quantum",
      }),
    ).toEqual([]);
  });

  it("an empty / whitespace query returns nothing", async () => {
    const s = writeSession("s-x", [{ kind: "user", text: "anything" }]);
    expect(
      await searchSessionTranscripts({
        transcriptDir: dir,
        sessions: [s],
        query: "",
      }),
    ).toEqual([]);
    expect(
      await searchSessionTranscripts({
        transcriptDir: dir,
        sessions: [s],
        query: "   ",
      }),
    ).toEqual([]);
  });

  it("skips an unreadable transcript and keeps scanning (best-effort)", async () => {
    const good = writeSession("s-good", [{ kind: "user", text: "find me" }]);
    const missing: SessionMetadata = {
      sessionId: "s-missing",
      workspaceRoot: "/repo",
      startedAt: "2026-07-11T00:00:00.000Z",
      lastActivityAt: "2026-07-11T00:00:00.000Z",
    };
    writeFileSync(join(dir, "s-corrupt.jsonl"), "not json at all\n");
    const corrupt: SessionMetadata = { ...missing, sessionId: "s-corrupt" };
    const hits = await searchSessionTranscripts({
      transcriptDir: dir,
      sessions: [missing, corrupt, good],
      query: "find me",
    });
    expect(hits.map((h) => h.sessionId)).toEqual(["s-good"]);
  });

  it("prefilter needle is the JSON-escaped, lowercased form of the query", async () => {
    expect(rawPrefilterNeedle("Parser")).toBe("parser");
    expect(rawPrefilterNeedle('a"B')).toBe('a\\"b');
    expect(rawPrefilterNeedle("a\\b")).toBe("a\\\\b");
    expect(rawPrefilterNeedle("换\n行")).toBe("换\\n行");
  });

  it("matches text containing JSON-escaped characters (quote query)", async () => {
    const s = writeSession("s-esc", [
      { kind: "user", text: 'she said "no way" and left' },
    ]);
    const hits = await searchSessionTranscripts({
      transcriptDir: dir,
      sessions: [s],
      query: '"no way"',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('"no way"');
  });

  it("a corrupt line skips THAT LINE — later lines still match (streaming rework)", async () => {
    // Hand-written file: valid header, one corrupt line, then a good block.
    // The old readSessionFile-based scan threw on the corrupt line and lost
    // the whole file's searchability.
    const header = JSON.stringify({
      _kind: "session_meta",
      version: 1,
      sessionId: "s-corrupt-mid",
      startedAt: "2026-07-12T00:00:00.000Z",
      workspaceRoot: "/repo",
    });
    const good = JSON.stringify({ kind: "user", text: "the survivor line" });
    writeFileSync(
      join(dir, "s-corrupt-mid.jsonl"),
      `${header}\n{not json — the survivor mention here is bait\n${good}\n`,
    );
    const meta: SessionMetadata = {
      sessionId: "s-corrupt-mid",
      workspaceRoot: "/repo",
      startedAt: "2026-07-12T00:00:00.000Z",
      lastActivityAt: "2026-07-12T00:00:00.000Z",
    };
    const hits = await searchSessionTranscripts({
      transcriptDir: dir,
      sessions: [meta],
      query: "survivor",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("the survivor line");
  });

  it("finds a CJK match whose bytes straddle the 64KB chunk boundary", async () => {
    // Position a 3-byte CJK char so the 64KB read boundary falls INSIDE it:
    // a naive buf.toString per chunk would emit replacement chars and the
    // prefilter would miss the line; the StringDecoder carries the split
    // sequence across chunks.
    const prefix = '{"kind":"user","text":"';
    const CHUNK = 64 * 1024;
    // The target char 目 starts at absolute byte CHUNK - 1 (1 byte in chunk
    // one, 2 bytes in chunk two). Everything before it is ASCII, so byte
    // offset == char offset.
    const fillerLen = CHUNK - 1 - 1 - prefix.length; // -1 for the "\n"
    const filler = "x".repeat(fillerLen);
    const line = `${prefix}目标词在这里"}`;
    writeFileSync(join(dir, "s-boundary.jsonl"), `${filler}\n${line}\n`);
    const meta: SessionMetadata = {
      sessionId: "s-boundary",
      workspaceRoot: "/repo",
      startedAt: "2026-07-12T00:00:00.000Z",
      lastActivityAt: "2026-07-12T00:00:00.000Z",
    };
    const hits = await searchSessionTranscripts({
      transcriptDir: dir,
      sessions: [meta],
      query: "目标词",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("目标词在这里");
  });

  it("brickQueryVariant maps @brick→@板砖 first, then bare brick→板砖, boundary-safe", async () => {
    expect(brickQueryVariant("@brick")).toBe("@板砖");
    expect(brickQueryVariant("@Brick")).toBe("@板砖"); // case-insensitive
    expect(brickQueryVariant("brick")).toBe("板砖");
    expect(brickQueryVariant("hand @brick this, brick is idle")).toBe(
      "hand @板砖 this, 板砖 is idle",
    );
    // Boundaries: embedded/suffixed forms never map.
    expect(brickQueryVariant("bob@brick.io")).toBe("bob@brick.io");
    expect(brickQueryVariant("bricks")).toBe("bricks");
    expect(brickQueryVariant("firebrick")).toBe("firebrick");
    // Nothing to map → identical (the caller then searches one variant).
    expect(brickQueryVariant("parser")).toBe("parser");
  });

  it("an EN user's 'brick' / '@brick' query matches the stored wire token 板砖", async () => {
    const s = writeSession("s-brick", [
      { kind: "user", text: "让 @板砖 修一下 parser" },
    ]);
    for (const query of ["brick", "@brick", "@Brick"]) {
      const hits = await searchSessionTranscripts({
        transcriptDir: dir,
        sessions: [s],
        query,
      });
      expect(hits).toHaveLength(1);
      // The snippet windows around the variant that matched — the record form.
      expect(hits[0]?.snippet).toContain("让 @板砖 修一下 parser");
    }
  });

  it("a literal 'brick' in the dialogue still matches the raw query (either variant hits)", async () => {
    const s = writeSession("s-brick-lit", [
      { kind: "user", text: "the brick wall pattern" },
    ]);
    const hits = await searchSessionTranscripts({
      transcriptDir: dir,
      sessions: [s],
      query: "brick",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("the brick wall pattern");
  });

  it("caps the hit count at the limit", async () => {
    const sessions = Array.from({ length: 5 }, (_, i) =>
      writeSession(`s-${i}`, [{ kind: "user", text: "common needle" }]),
    );
    const hits = await searchSessionTranscripts({
      transcriptDir: dir,
      sessions,
      query: "needle",
      limit: 3,
    });
    expect(hits).toHaveLength(3);
  });
});

describe("narrowSearchCandidates — a query that extends the last one scans only its hits (2026-09-03)", () => {
  const meta = (id: string): SessionMetadata => ({
    sessionId: id,
    workspaceRoot: "/repo",
    startedAt: "2026-09-03T00:00:00.000Z",
    lastActivityAt: "2026-09-03T00:00:00.000Z",
  });
  const all = [meta("a"), meta("b"), meta("c"), meta("d")];
  const memo = (over: Partial<SearchMemo> = {}): SearchMemo => ({
    query: "par",
    hitSessionIds: ["b", "d"],
    exhaustive: true,
    candidateCount: all.length,
    at: 1_000_000,
    ...over,
  });
  const now = 1_000_500;

  it("narrows to the previous hits when the new query contains the old one", () => {
    const out = narrowSearchCandidates(memo(), "parser", all, { now });
    expect(out.map((s) => s.sessionId)).toEqual(["b", "d"]);
  });

  it("keeps the listing's order and always includes the open session", () => {
    const out = narrowSearchCandidates(memo(), "parser", all, {
      now,
      alwaysInclude: "a",
    });
    expect(out.map((s) => s.sessionId)).toEqual(["a", "b", "d"]);
  });

  it("scans everything with no memo, a non-exhaustive memo, or an unrelated query", () => {
    expect(narrowSearchCandidates(null, "parser", all, { now })).toBe(all);
    expect(
      narrowSearchCandidates(memo({ exhaustive: false }), "parser", all, {
        now,
      }),
    ).toBe(all);
    // "pa" is a PREFIX of the old query, not an extension: it can match more.
    expect(narrowSearchCandidates(memo(), "pa", all, { now })).toBe(all);
    expect(narrowSearchCandidates(memo(), "cursor", all, { now })).toBe(all);
  });

  it("scans everything when the listing changed size or the memo is stale", () => {
    expect(
      narrowSearchCandidates(memo(), "parser", [...all, meta("e")], { now }),
    ).toHaveLength(5);
    expect(
      narrowSearchCandidates(memo(), "parser", all, {
        now: 1_000_000 + SEARCH_MEMO_MAX_AGE_MS + 1,
      }),
    ).toBe(all);
  });

  it("scans everything when the 板砖 alias enters the query (ADR 0015)", () => {
    // "bric" matched literally; "brick" also matches the stored 板砖 token,
    // which a session with no literal "bric" may carry.
    const m = memo({ query: "bric", hitSessionIds: ["c"] });
    expect(narrowSearchCandidates(m, "brick", all, { now })).toBe(all);
    // Alias on both sides, still an extension: narrowing holds.
    const m2 = memo({ query: "@brick", hitSessionIds: ["c"] });
    expect(
      narrowSearchCandidates(m2, "@brick 修", all, { now }).map(
        (s) => s.sessionId,
      ),
    ).toEqual(["c"]);
  });

  it("is case-insensitive like the search itself", () => {
    const out = narrowSearchCandidates(memo(), "PARSER", all, { now });
    expect(out.map((s) => s.sessionId)).toEqual(["b", "d"]);
  });
});
