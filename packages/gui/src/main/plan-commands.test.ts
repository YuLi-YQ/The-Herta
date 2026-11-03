import type { PlanReply, PlanView } from "@herta/core";
import { describe, expect, it, vi } from "vitest";
import { createPlanCommands } from "./plan-commands.js";

const view: PlanView = {
  locked: false,
  state: {
    revision: 0,
    active: false,
    previousMode: null,
    plan: null,
    history: [],
  },
};
function fixture() {
  const target = {
    sessionId: "task-a",
    getPlan: vi.fn<() => PlanReply>(() => ({ ok: true, view })),
    updatePlan: vi.fn<() => PlanReply>(() => ({ ok: true, view })),
  };
  const changing = vi.fn(() => false);
  return {
    target,
    changing,
    commands: createPlanCommands(() => target, changing),
  };
}
describe("plan IPC boundary", () => {
  it("rejects stale target IDs, invalid revisions and renderer-supplied grants without dispatch", () => {
    const { commands, target } = fixture();
    expect(commands.getSessionPlan("../task-a")).toMatchObject({
      reason: "no_target",
    });
    expect(
      commands.updateSessionPlan("task-b", 0, { type: "enter" }),
    ).toMatchObject({ reason: "no_target" });
    for (const [revision, action] of [
      [-1, { type: "enter" }],
      [1.5, { type: "enter" }],
      [Number.MAX_SAFE_INTEGER + 1, { type: "enter" }],
      [0, { type: "enter", previousMode: "full-access" }],
      [0, { type: "exit", confirmFullAccess: "yes" }],
      [0, { type: "exit", permission: "full-access" }],
      [0, { type: "save", text: 7 }],
      [0, null],
    ])
      expect(
        commands.updateSessionPlan("task-a", revision, action),
      ).toMatchObject({ reason: "invalid" });
    expect(target.getPlan).not.toHaveBeenCalled();
    expect(target.updatePlan).not.toHaveBeenCalled();
  });
  it("passes valid intent to the session and leaves confirmation and conflicts authoritative", () => {
    const { commands, target } = fixture();
    const denied: PlanReply = {
      ok: false,
      reason: "confirmation_required",
      view: { ...view, locked: true },
    };
    target.updatePlan.mockReturnValueOnce(denied);
    expect(commands.updateSessionPlan("task-a", 2, { type: "exit" })).toBe(
      denied,
    );
    expect(target.updatePlan).toHaveBeenLastCalledWith(2, { type: "exit" });
    commands.updateSessionPlan("task-a", 2, {
      type: "exit",
      confirmFullAccess: true,
    });
    expect(target.updatePlan).toHaveBeenLastCalledWith(2, {
      type: "exit",
      confirmFullAccess: true,
    });
    expect(commands.getSessionPlan("task-a")).toMatchObject({ ok: true, view });
  });
  it("blocks mutations during task switching and never leaks raw storage errors", () => {
    const { commands, target, changing } = fixture();
    changing.mockReturnValueOnce(true);
    expect(commands.updateSessionPlan("task-a", 0, { type: "enter" })).toEqual({
      ok: false,
      reason: "busy",
    });
    expect(target.updatePlan).not.toHaveBeenCalled();
    target.getPlan.mockImplementation(() => {
      throw new Error("private file path and content");
    });
    expect(commands.getSessionPlan("task-a")).toEqual({
      ok: false,
      reason: "storage",
    });
    const missing = createPlanCommands(() => ({ sessionId: "task-a" }));
    expect(missing.getSessionPlan("task-a")).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});
