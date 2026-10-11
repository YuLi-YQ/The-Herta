import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalRecordBlock } from "@herta/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { V2RecordPersister } from "./v2-record-persister.js";

describe("V2RecordPersister", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "v2-persist-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("forNewSession", () => {
    it("writes a session_meta header on construction", () => {
      const p = V2RecordPersister.forNewSession({
        sessionId: "abc123",
        workspaceRoot: "/proj/x",
        startedAt: new Date("2026-05-15T12:00:00.000Z"),
        transcriptDir: tmp,
      });
      const content = readFileSync(p.sessionFile, "utf8");
      const firstLine = content.split("\n")[0];
      expect(firstLine).toBe(
        JSON.stringify({
          _kind: "session_meta",
          version: 1,
          sessionId: "abc123",
          startedAt: "2026-05-15T12:00:00.000Z",
          workspaceRoot: "/proj/x",
        }),
      );
    });

    it("places sessionFile at <transcriptDir>/<sessionId>.jsonl", () => {
      const p = V2RecordPersister.forNewSession({
        sessionId: "abc123",
        workspaceRoot: "/proj/x",
        startedAt: new Date(),
        transcriptDir: tmp,
      });
      expect(p.sessionFile).toBe(join(tmp, "abc123.jsonl"));
    });

    it("creates the transcriptDir if it does not exist", () => {
      const nested = join(tmp, "deep", "nested");
      const p = V2RecordPersister.forNewSession({
        sessionId: "abc",
        workspaceRoot: "/proj/x",
        startedAt: new Date(),
        transcriptDir: nested,
      });
      expect(readFileSync(p.sessionFile, "utf8")).toContain("session_meta");
    });
  });

  describe("appendBlock", () => {
    it("appends one JSON line per block, in order", () => {
      const p = V2RecordPersister.forNewSession({
        sessionId: "abc",
        workspaceRoot: "/proj/x",
        startedAt: new Date("2026-05-15T12:00:00.000Z"),
        transcriptDir: tmp,
        // Fixed clock so the per-block `at` stamp is deterministic.
        now: () => "2026-05-15T12:34:56.000Z",
      });
      p.appendBlock({ kind: "user", text: "在吗" });
      p.appendBlock({ kind: "herta", surface: "speech", text: "在。" });
      p.appendBlock({ kind: "system", label: "系统", body: "ok" });
      const lines = readFileSync(p.sessionFile, "utf8").split("\n");
      expect(lines).toHaveLength(5); // header + 3 blocks + trailing empty
      // Each persisted block carries the stamped `at`.
      expect(JSON.parse(lines[1]!)).toEqual({
        kind: "user",
        text: "在吗",
        at: "2026-05-15T12:34:56.000Z",
      });
      expect(JSON.parse(lines[2]!)).toEqual({
        kind: "herta",
        surface: "speech",
        text: "在。",
        at: "2026-05-15T12:34:56.000Z",
      });
      expect(JSON.parse(lines[3]!)).toEqual({
        kind: "system",
        label: "系统",
        body: "ok",
        at: "2026-05-15T12:34:56.000Z",
      });
    });

    it("each block ends with a newline", () => {
      const p = V2RecordPersister.forNewSession({
        sessionId: "abc",
        workspaceRoot: "/proj/x",
        startedAt: new Date(),
        transcriptDir: tmp,
      });
      p.appendBlock({ kind: "user", text: "hi" });
      const content = readFileSync(p.sessionFile, "utf8");
      expect(content.endsWith("\n")).toBe(true);
    });
  });

  describe("forResume", () => {
    it("opens an existing file and appends without writing a new header", () => {
      // First session: write header + 2 blocks.
      const initial = V2RecordPersister.forNewSession({
        sessionId: "abc",
        workspaceRoot: "/proj/x",
        startedAt: new Date("2026-05-15T12:00:00.000Z"),
        transcriptDir: tmp,
      });
      initial.appendBlock({ kind: "user", text: "first" });
      initial.appendBlock({ kind: "herta", surface: "speech", text: "好" });

      // Now resume with a fresh persister pointing at the same file.
      const resumed = V2RecordPersister.forResume({
        sessionFile: initial.sessionFile,
        now: () => "2026-05-15T13:00:00.000Z",
      });
      resumed.appendBlock({ kind: "user", text: "second" });

      const lines = readFileSync(resumed.sessionFile, "utf8")
        .split("\n")
        .filter((l) => l.length > 0);
      expect(lines).toHaveLength(4); // header + 3 blocks
      // The header is still the original — no duplicate.
      expect(JSON.parse(lines[0]!)._kind).toBe("session_meta");
      expect(JSON.parse(lines[3]!)).toEqual({
        kind: "user",
        text: "second",
        at: "2026-05-15T13:00:00.000Z",
      });
    });

    it("sessionFile getter returns the path we opened", () => {
      const path = join(tmp, "myid.jsonl");
      // Pre-create with a header line so forResume has something to point at.
      const seeded = V2RecordPersister.forNewSession({
        sessionId: "myid",
        workspaceRoot: "/p",
        startedAt: new Date(),
        transcriptDir: tmp,
      });
      const resumed = V2RecordPersister.forResume({ sessionFile: path });
      expect(resumed.sessionFile).toBe(path);
      expect(seeded.sessionFile).toBe(path);
    });
  });
});

describe("V2RecordPersister + readSessionFile round-trip", () => {
  it("write → read returns the record (with per-block `at`) + meta", async () => {
    const { readSessionFile } = await import("@herta/core");
    const tmpDir = mkdtempSync(join(tmpdir(), "v2-roundtrip-"));
    try {
      const at = "2026-05-15T12:34:56.000Z";
      const p = V2RecordPersister.forNewSession({
        sessionId: "rt-1",
        workspaceRoot: "/proj/x",
        startedAt: new Date("2026-05-15T12:00:00.000Z"),
        transcriptDir: tmpDir,
        now: () => at,
      });
      const original: TerminalRecordBlock[] = [
        { kind: "user", text: "看 foo.ts" },
        { kind: "herta", surface: "speech", text: "好" },
        {
          kind: "system",
          label: "系统",
          body: "[文件内容：foo.ts]\nexport const x = 1;",
        },
        { kind: "herta", surface: "speech", text: "看完了。" },
      ];
      for (const b of original) p.appendBlock(b);

      const { meta, record } = readSessionFile(p.sessionFile);
      expect(meta).toEqual({
        version: 1,
        sessionId: "rt-1",
        startedAt: "2026-05-15T12:00:00.000Z",
        workspaceRoot: "/proj/x",
      });
      // The persister stamps a per-block `at` on write; everything else
      // round-trips unchanged.
      expect(record).toEqual(original.map((b) => ({ ...b, at })));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
