import { emptyGoalState, type GoalReply } from "@herta/core";
import { describe, expect, it, vi } from "vitest";
import { createGoalCommands } from "./goal-commands.js";
const reply: GoalReply = { ok: true, view: { state: emptyGoalState() } };
function fixture() {
  const session = {
    sessionId: "task-a",
    getGoal: vi.fn(() => reply),
    updateGoal: vi.fn(() => reply),
  };
  const chat = { getGoal: vi.fn(() => reply), updateGoal: vi.fn(() => reply) };
  const handlers = createGoalCommands({ session: () => session, chat });
  return { session, chat, handlers };
}
describe("goal IPC boundary", () => {
  it("never dispatches stale task updates or malformed input", () => {
    const { session, handlers } = fixture();
    expect(
      handlers.updateSessionGoal("task-b", 0, { type: "set", text: "x" }),
    ).toMatchObject({ ok: false, reason: "no_target" });
    for (const [rev, action] of [
      [-1, { type: "reset" }],
      [1.5, { type: "reset" }],
      [0, { type: "set", text: "a".repeat(501) }],
      [0, { type: "set", text: "x", permission: "full-access" }],
      [0, null],
    ])
      expect(handlers.updateSessionGoal("task-a", rev, action)).toMatchObject({
        ok: false,
        reason: "invalid",
      });
    expect(session.updateGoal).not.toHaveBeenCalled();
    expect(handlers.getSessionGoal("../task-a")).toMatchObject({ ok: false });
    expect(session.getGoal).not.toHaveBeenCalled();
  });
  it("forwards valid actions and authoritative conflict state without granting access", () => {
    const { session, chat, handlers } = fixture();
    expect(
      handlers.updateSessionGoal("task-a", 3, {
        type: "set",
        text: "  goal  ",
      }),
    ).toBe(reply);
    expect(session.updateGoal).toHaveBeenCalledWith(3, {
      type: "set",
      text: "goal",
    });
    expect(handlers.getChatGoal("chat-a")).toBe(reply);
    expect(
      handlers.updateChatGoal("chat-a", 4, {
        type: "end",
        status: "dropped",
        result: "later",
      }),
    ).toBe(reply);
    expect(chat.updateGoal).toHaveBeenCalledWith("chat-a", 4, {
      type: "end",
      status: "dropped",
      result: "later",
    });
    session.updateGoal.mockReturnValueOnce({
      ok: false,
      reason: "conflict",
      view: { state: { ...emptyGoalState(), revision: 5 } },
    });
    expect(
      handlers.updateSessionGoal("task-a", 3, { type: "reset" }),
    ).toMatchObject({
      ok: false,
      reason: "conflict",
      view: { state: { revision: 5 } },
    });
  });
  it("bounds chat input and replaces raw storage exceptions with a fixed error", () => {
    const { session, chat, handlers } = fixture();
    expect(
      handlers.updateChatGoal("chat-a", 0, { type: "end", status: "active" }),
    ).toMatchObject({ reason: "invalid" });
    expect(chat.updateGoal).not.toHaveBeenCalled();
    session.getGoal.mockImplementation(() => {
      throw new Error("private path or data");
    });
    expect(handlers.getSessionGoal("task-a")).toEqual({
      ok: false,
      reason: "storage",
    });
  });
});
