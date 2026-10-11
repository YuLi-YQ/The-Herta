import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSessionFile, SessionFileError } from "./read-session-file.js";
import { V2RecordPersister } from "./v2-record-persister.js";

describe("V2RecordPersister.appendBlock", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "v2-persist-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function blockLines(file: string): Record<string, unknown>[] {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((o) => o._kind === undefined); // drop the session_meta header
  }

  function newPersister(id: string): V2RecordPersister {
    return V2RecordPersister.forNewSession({
      sessionId: id,
      workspaceRoot: "/w",
      startedAt: new Date("2026-06-18T00:00:00.000Z"),
      transcriptDir: tmp,
      now: () => "2026-06-18T09:30:00.000Z",
    });
  }

  it("stamps a per-block `at` from the injected clock when the block lacks one", () => {
    const p = newPersister("s1");
    p.appendBlock({ kind: "user", text: "hi" });
    expect(blockLines(p.sessionFile)[0]).toEqual({
      kind: "user",
      text: "hi",
      at: "2026-06-18T09:30:00.000Z",
    });
  });

  it("preserves an already-stamped `at` verbatim (no double-stamp)", () => {
    const p = newPersister("s2");
    p.appendBlock({
      kind: "herta",
      surface: "speech",
      text: "好",
      at: "2026-06-18T08:00:00.000Z",
    });
    expect(blockLines(p.sessionFile)[0]?.at).toBe("2026-06-18T08:00:00.000Z");
  });
});

describe("V2RecordPersister.truncateToBlockCount", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "v2-truncate-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function newPersister(id: string): V2RecordPersister {
    return V2RecordPersister.forNewSession({
      sessionId: id,
      workspaceRoot: "/w",
      startedAt: new Date("2026-06-18T00:00:00.000Z"),
      transcriptDir: tmp,
      now: () => "2026-06-18T09:30:00.000Z",
    });
  }

  function allLines(file: string): Record<string, unknown>[] {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  function blockLines(file: string): Record<string, unknown>[] {
    return allLines(file).filter((o) => o._kind === undefined);
  }

  it("keeps the first N blocks and drops the rest, header preserved", () => {
    const p = newPersister("t1");
    p.appendBlock({ kind: "user", text: "u1" });
    p.appendBlock({ kind: "herta", surface: "speech", text: "h1" });
    p.appendBlock({ kind: "user", text: "u2" });
    p.appendBlock({ kind: "herta", surface: "speech", text: "h2" });

    p.truncateToBlockCount(2); // keep [u1, h1]; drop the second turn

    const blocks = blockLines(p.sessionFile);
    expect(blocks.map((b) => b.text)).toEqual(["u1", "h1"]);
    // Header survives as line 1.
    expect(allLines(p.sessionFile)[0]?._kind).toBe("session_meta");
  });

  it("writes the interaction lang into the header when provided, omits it otherwise", () => {
    const withLang = V2RecordPersister.forNewSession({
      sessionId: "L1",
      workspaceRoot: "/w",
      lang: "en",
      startedAt: new Date("2026-07-15T00:00:00.000Z"),
      transcriptDir: tmp,
    });
    expect(allLines(withLang.sessionFile)[0]?.lang).toBe("en");
    // No lang passed → the header has no lang key (legacy-compatible).
    expect(allLines(newPersister("L2").sessionFile)[0]).not.toHaveProperty(
      "lang",
    );
  });

  it("truncating to 0 leaves only the header (empty record)", () => {
    const p = newPersister("t2");
    p.appendBlock({ kind: "user", text: "only" });
    p.truncateToBlockCount(0);
    expect(blockLines(p.sessionFile)).toEqual([]);
    expect(allLines(p.sessionFile)).toHaveLength(1); // header only
  });

  it("preserves a workspace_set inside the kept prefix, drops one in the withdrawn span", () => {
    const p = newPersister("t3");
    p.appendBlock({ kind: "user", text: "u1" });
    p.appendWorkspaceSet("/kept", "2026-06-18T09:00:00.000Z"); // before the cut
    p.appendBlock({ kind: "herta", surface: "speech", text: "h1" });
    p.appendBlock({ kind: "user", text: "u2" });
    p.appendWorkspaceSet("/dropped", "2026-06-18T09:10:00.000Z"); // withdrawn span
    p.appendBlock({ kind: "herta", surface: "speech", text: "h2" });

    p.truncateToBlockCount(2); // keep [u1, h1]

    const all = allLines(p.sessionFile);
    const workspaceSets = all.filter((o) => o._kind === "workspace_set");
    expect(workspaceSets.map((w) => w.path)).toEqual(["/kept"]);
    expect(blockLines(p.sessionFile).map((b) => b.text)).toEqual(["u1", "h1"]);
  });

  it("keeps a workspace_set sitting EXACTLY at the rewind boundary (audit §6)", () => {
    // The meta line lands after the last kept block and before the first
    // withdrawn one. Pre-fix the count check ran before the meta-line check,
    // so this workspace_set was dropped with the withdrawn span and a resume
    // reverted the workspace — masked only because appendWorkspaceSet call
    // sites append a → 系统 note block immediately after the meta line.
    const p = newPersister("t6");
    p.appendBlock({ kind: "user", text: "u1" });
    p.appendBlock({ kind: "herta", surface: "speech", text: "h1" });
    p.appendWorkspaceSet("/boundary", "2026-06-18T09:05:00.000Z");
    p.appendBlock({ kind: "user", text: "u2" }); // first withdrawn block
    p.appendBlock({ kind: "herta", surface: "speech", text: "h2" });

    p.truncateToBlockCount(2); // keep [u1, h1] — and the boundary meta line

    const all = allLines(p.sessionFile);
    const workspaceSets = all.filter((o) => o._kind === "workspace_set");
    expect(workspaceSets.map((w) => w.path)).toEqual(["/boundary"]);
    expect(blockLines(p.sessionFile).map((b) => b.text)).toEqual(["u1", "h1"]);
  });

  it("keeping all blocks (count === length) is a no-op on the blocks", () => {
    const p = newPersister("t4");
    p.appendBlock({ kind: "user", text: "u1" });
    p.appendBlock({ kind: "herta", surface: "speech", text: "h1" });
    p.truncateToBlockCount(2);
    expect(blockLines(p.sessionFile).map((b) => b.text)).toEqual(["u1", "h1"]);
  });

  it("re-appending after a truncate continues the file cleanly", () => {
    const p = newPersister("t5");
    p.appendBlock({ kind: "user", text: "u1" });
    p.appendBlock({ kind: "herta", surface: "speech", text: "h1" });
    p.appendBlock({ kind: "user", text: "u2" });
    p.truncateToBlockCount(2);
    p.appendBlock({ kind: "user", text: "u2-edited" });
    expect(blockLines(p.sessionFile).map((b) => b.text)).toEqual([
      "u1",
      "h1",
      "u2-edited",
    ]);
  });
});

describe("V2RecordPersister.forResume — heal truncated trailing line", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "v2-heal-"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function newPersister(id: string): V2RecordPersister {
    return V2RecordPersister.forNewSession({
      sessionId: id,
      workspaceRoot: "/w",
      startedAt: new Date("2026-06-18T00:00:00.000Z"),
      transcriptDir: tmp,
      now: () => "2026-06-18T09:30:00.000Z",
    });
  }

  it("crash repro: heal + append + read round-trips the full history", () => {
    // A crash mid-append leaves a partial JSON fragment with NO trailing
    // newline. Without the heal, the next append fuses onto it — the fused
    // line is then mid-file and readSessionFile throws corrupt-line forever.
    const p = newPersister("crash");
    p.appendBlock({ kind: "user", text: "u1" });
    p.appendBlock({ kind: "herta", surface: "speech", text: "h1" });
    appendFileSync(p.sessionFile, '{"kind":"herta","sur', "utf8");

    const resumed = V2RecordPersister.forResume({
      sessionFile: p.sessionFile,
      now: () => "2026-06-18T10:00:00.000Z",
    });
    resumed.appendBlock({ kind: "user", text: "u2" });

    const { record } = readSessionFile(p.sessionFile);
    expect(record.map((b) => (b as { text?: string }).text)).toEqual([
      "u1",
      "h1",
      "u2",
    ]);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("is a no-op on a file that already ends in a newline", () => {
    const p = newPersister("clean");
    p.appendBlock({ kind: "user", text: "u1" });
    const before = readFileSync(p.sessionFile, "utf8");
    V2RecordPersister.forResume({ sessionFile: p.sessionFile });
    expect(readFileSync(p.sessionFile, "utf8")).toBe(before);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("is a no-op when the file does not exist yet", () => {
    expect(() =>
      V2RecordPersister.forResume({ sessionFile: join(tmp, "missing.jsonl") }),
    ).not.toThrow();
  });

  it("leaves a partial-header-only file for readSessionFile's bad-header", () => {
    const file = join(tmp, "partial-header.jsonl");
    appendFileSync(file, '{"_kind":"session_m', "utf8");
    V2RecordPersister.forResume({ sessionFile: file });
    expect(readFileSync(file, "utf8")).toBe('{"_kind":"session_m');
    expect(() => readSessionFile(file)).toThrow(SessionFileError);
  });
});

describe("V2RecordPersister.replaceBlockAt (ADR 0033 removal)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "v2-replace-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function seeded() {
    const p = V2RecordPersister.forNewSession({
      sessionId: "s-1",
      workspaceRoot: "/repo",
      startedAt: new Date("2026-08-10T00:00:00.000Z"),
      transcriptDir: tmp,
    });
    p.appendBlock({ kind: "user", text: "one" });
    p.appendWorkspaceSet("/other", "2026-08-10T00:00:01.000Z");
    p.appendBlock({ kind: "system", label: "系统", body: "two" });
    p.appendBlock({ kind: "herta", surface: "speech", text: "three" });
    return p;
  }

  it("replaces the addressed block and leaves every other line intact", () => {
    const p = seeded();
    p.replaceBlockAt(1, { kind: "system", label: "系统", body: "REPLACED" });
    const { record, latestWorkspaceSet } = readSessionFile(p.sessionFile);
    // Same count — the whole point: rewind, topic anchors and the sink cursor
    // all index by block position.
    expect(record).toHaveLength(3);
    expect(record[0]).toMatchObject({ kind: "user", text: "one" });
    expect(record[1]).toMatchObject({ body: "REPLACED" });
    expect(record[2]).toMatchObject({ text: "three" });
    // The interleaved meta line survived.
    expect(latestWorkspaceSet).toBe("/other");
  });

  it("counts BLOCKS, not lines — a meta line never shifts the index", () => {
    const p = seeded();
    // Block 2 sits after the workspace_set meta line; a line-indexed
    // implementation would hit the wrong row here.
    p.replaceBlockAt(2, { kind: "system", label: "系统", body: "LAST" });
    const { record } = readSessionFile(p.sessionFile);
    expect(record[2]).toMatchObject({ body: "LAST" });
    expect(record[1]).toMatchObject({ body: "two" });
  });

  it("is a no-op past the end rather than an error", () => {
    const p = seeded();
    const before = readFileSync(p.sessionFile, "utf8");
    p.replaceBlockAt(99, { kind: "system", label: "系统", body: "nope" });
    expect(readFileSync(p.sessionFile, "utf8")).toBe(before);
  });

  it("survives the round-trip as a real record", () => {
    const p = seeded();
    p.replaceBlockAt(1, {
      kind: "system",
      label: "系统",
      body: "附件 spec.md · 已移除",
      digest: {
        kind: "attachment",
        name: "spec.md",
        path: ".herta/attachments/s-1/spec-ab12cd34.md",
        lines: 0,
        chars: 0,
        unreadable: "removed",
      },
    });
    const { record } = readSessionFile(p.sessionFile);
    const b = record[1];
    expect(b?.kind === "system" && b.digest).toMatchObject({
      kind: "attachment",
      unreadable: "removed",
    });
  });

  it("keeps the line's original `at` when the replacement carries none (2026-08-17)", () => {
    // In-memory blocks never hold `at` (appendBlock stamps it), so a replaced
    // block used to lose its timestamp — a real record showed a removed
    // attachment as the only block with no time. Withdrawal does not move
    // when the attach happened.
    const p = seeded();
    const before = readSessionFile(p.sessionFile).record[1] as { at?: string };
    expect(typeof before.at).toBe("string");
    p.replaceBlockAt(1, { kind: "system", label: "系统", body: "REPLACED" });
    const after = readSessionFile(p.sessionFile).record[1] as { at?: string };
    expect(after.at).toBe(before.at);
    // An explicitly stamped replacement wins, as before.
    p.replaceBlockAt(1, {
      kind: "system",
      label: "系统",
      body: "AGAIN",
      at: "2030-01-01T00:00:00.000Z",
    } as never);
    expect(
      (readSessionFile(p.sessionFile).record[1] as { at?: string }).at,
    ).toBe("2030-01-01T00:00:00.000Z");
  });
});
