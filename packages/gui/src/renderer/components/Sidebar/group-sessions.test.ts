import type { SessionMetadata } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import { groupSessions } from "./group-sessions.js";

function mkSession(sessionId: string, lastActivityAt: string): SessionMetadata {
  return {
    sessionId,
    workspaceRoot: "/repo",
    startedAt: lastActivityAt,
    lastActivityAt,
  };
}

describe("groupSessions", () => {
  const now = new Date("2026-05-28T12:00:00Z");

  it("groups by Today / Yesterday / Previous 7 Days / Older", () => {
    const sessions = [
      mkSession("a", "2026-05-28T10:00:00Z"), // today
      mkSession("b", "2026-05-27T10:00:00Z"), // yesterday
      mkSession("c", "2026-05-24T10:00:00Z"), // previous 7 days
      mkSession("d", "2026-05-15T10:00:00Z"), // older
    ];
    const groups = groupSessions(sessions, now);
    expect(groups.get("Today")?.map((s) => s.sessionId)).toEqual(["a"]);
    expect(groups.get("Yesterday")?.map((s) => s.sessionId)).toEqual(["b"]);
    expect(groups.get("Previous 7 Days")?.map((s) => s.sessionId)).toEqual([
      "c",
    ]);
    expect(groups.get("Older")?.map((s) => s.sessionId)).toEqual(["d"]);
  });

  it("preserves input order within each group", () => {
    const sessions = [
      mkSession("a", "2026-05-28T11:00:00Z"),
      mkSession("b", "2026-05-28T10:00:00Z"),
      mkSession("c", "2026-05-28T09:00:00Z"),
    ];
    const groups = groupSessions(sessions, now);
    expect(groups.get("Today")?.map((s) => s.sessionId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("omits empty groups", () => {
    const sessions = [mkSession("a", "2026-05-28T10:00:00Z")];
    const groups = groupSessions(sessions, now);
    expect(groups.has("Today")).toBe(true);
    expect(groups.has("Yesterday")).toBe(false);
  });
});
