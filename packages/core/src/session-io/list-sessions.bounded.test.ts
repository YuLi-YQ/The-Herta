import * as fs from "node:fs";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSessions } from "./list-sessions.js";

// Count the OPENS the listing performs: the point of the bound is that a
// transcript past the limit is never opened, only stat'd.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

function header(id: string, root: string): string {
  return JSON.stringify({
    _kind: "session_meta",
    version: 1,
    sessionId: id,
    startedAt: "2026-09-03T00:00:00.000Z",
    workspaceRoot: root,
  });
}

function seed(dir: string, id: string, root: string, ageSeconds: number): void {
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(
    file,
    `${header(id, root)}\n${JSON.stringify({ kind: "user", text: `hello from ${id}` })}\n`,
  );
  const t = Date.now() / 1000 - ageSeconds;
  utimesSync(file, t, t);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herta-list-bounded-"));
  vi.mocked(fs.openSync).mockClear();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("listSessions — reads only as many transcripts as the limit needs (2026-09-03)", () => {
  it("opens exactly `limit` files when they all belong to the workspace, newest first", () => {
    for (let i = 0; i < 6; i += 1) seed(dir, `s${i}`, "/w", i * 60);
    const result = listSessions({
      transcriptDir: dir,
      currentWorkspaceRoot: "/w",
      limit: 2,
    });
    expect(result.map((e) => e.sessionId)).toEqual(["s0", "s1"]);
    expect(vi.mocked(fs.openSync)).toHaveBeenCalledTimes(2);
  });

  it("a newer file from another workspace is read (its root is in its header) but does not count", () => {
    seed(dir, "other", "/elsewhere", 0);
    for (let i = 0; i < 4; i += 1) seed(dir, `s${i}`, "/w", (i + 1) * 60);
    const result = listSessions({
      transcriptDir: dir,
      currentWorkspaceRoot: "/w",
      limit: 2,
    });
    expect(result.map((e) => e.sessionId)).toEqual(["s0", "s1"]);
    // The foreign file plus the two kept ones; s2 and s3 were never opened.
    expect(vi.mocked(fs.openSync)).toHaveBeenCalledTimes(3);
  });

  it("an unlimited listing still reads everything, in the same newest-first order", () => {
    for (let i = 0; i < 5; i += 1) seed(dir, `s${i}`, "/w", i * 60);
    const result = listSessions({
      transcriptDir: dir,
      currentWorkspaceRoot: "/w",
      limit: Number.POSITIVE_INFINITY,
    });
    expect(result.map((e) => e.sessionId)).toEqual([
      "s0",
      "s1",
      "s2",
      "s3",
      "s4",
    ]);
    expect(vi.mocked(fs.openSync)).toHaveBeenCalledTimes(5);
  });
});
