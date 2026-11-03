import type { CompactReply, CompactView } from "@herta/core";
import { expect, it, vi } from "vitest";
import { createCompactCommands } from "./compact-commands.js";
const view: CompactView = {
  revision: 0,
  status: "idle",
  scheduledPersistent: false,
  recap: null,
  recordLength: 10,
};
const fixture = () => {
  const target = {
    sessionId: "a",
    getCompact: vi.fn<() => CompactReply>(() => ({ ok: true, view })),
    updateCompact: vi.fn<() => CompactReply>(() => ({ ok: true, view })),
  };
  const changing = vi.fn(() => false);
  return {
    target,
    changing,
    commands: createCompactCommands(() => target, changing),
  };
};
it("rejects stale targets, malformed input and fabricated summary data before dispatch", () => {
  const { commands, target } = fixture();
  expect(commands.getSessionCompact("../a")).toEqual({
    ok: false,
    reason: "no_target",
  });
  expect(commands.updateSessionCompact("b", 0, { type: "schedule" })).toEqual({
    ok: false,
    reason: "no_target",
  });
  for (const [revision, action] of [
    [-1, { type: "schedule" }],
    [0.5, { type: "cancel" }],
    [NaN, { type: "cancel" }],
    [0, { type: "schedule", recap: "forged" }],
    [0, { type: "cancel", boundaryIndex: 7 }],
    [0, null],
  ]) {
    expect(commands.updateSessionCompact("a", revision, action)).toEqual({
      ok: false,
      reason: "invalid",
    });
  }
  expect(target.getCompact).not.toHaveBeenCalled();
  expect(target.updateCompact).not.toHaveBeenCalled();
});
it("dispatches validated intent and preserves runtime conflict/busy outcomes", () => {
  const { commands, target } = fixture();
  expect(commands.getSessionCompact("a")).toEqual({ ok: true, view });
  const conflict: CompactReply = { ok: false, reason: "conflict", view };
  target.updateCompact.mockReturnValueOnce(conflict);
  expect(commands.updateSessionCompact("a", 3, { type: "schedule" })).toBe(
    conflict,
  );
  expect(target.updateCompact).toHaveBeenLastCalledWith(3, {
    type: "schedule",
  });
  commands.updateSessionCompact("a", 0, { type: "cancel" });
  expect(target.updateCompact).toHaveBeenLastCalledWith(0, { type: "cancel" });
});
it("blocks changing tasks and hides raw host errors", () => {
  const { commands, target, changing } = fixture();
  changing.mockReturnValue(true);
  expect(commands.updateSessionCompact("a", 0, { type: "schedule" })).toEqual({
    ok: false,
    reason: "busy",
  });
  expect(target.updateCompact).not.toHaveBeenCalled();
  target.getCompact.mockImplementation(() => {
    throw Error("private path");
  });
  expect(commands.getSessionCompact("a")).toEqual({
    ok: false,
    reason: "unavailable",
  });
  expect(
    createCompactCommands(() => ({ sessionId: "a" })).getSessionCompact("a"),
  ).toEqual({ ok: false, reason: "unavailable" });
});
