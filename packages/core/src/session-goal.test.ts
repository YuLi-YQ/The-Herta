import { describe, expect, it } from "vitest";
import {
  changeGoal,
  emptyGoalState,
  goalContext,
  parseGoalAction,
  parseGoalState,
} from "./session-goal.js";
const now = "2026-11-01T01:00:00.000Z";
function active(text = "核对附件") {
  const r = changeGoal(emptyGoalState(), 0, { type: "set", text }, now);
  if (!r.ok) throw new Error(r.reason);
  return r.view.state;
}
describe("user-owned goal state", () => {
  it("updates an active goal and ends it into immutable history", () => {
    const first = active();
    const update = changeGoal(
      first,
      1,
      { type: "set", text: "核对两张附件" },
      now,
    );
    expect(update.ok).toBe(true);
    if (!update.ok) return;
    const end = changeGoal(
      update.view.state,
      2,
      { type: "end", status: "done", result: "手动核验通过" },
      now,
    );
    expect(end.ok).toBe(true);
    if (!end.ok) return;
    expect(end.view.state).toMatchObject({
      revision: 3,
      active: null,
      history: [
        {
          text: "核对两张附件",
          status: "done",
          result: "手动核验通过",
          setAt: now,
          endedAt: now,
        },
      ],
    });
    expect(first.active?.text).toBe("核对附件");
    expect(parseGoalState(end.view.state)).toEqual(end.view.state);
    expect(goalContext(end.view.state, "zh")).toBe("");
  });
  it("refuses stale, invalid and host-only recovery actions without changing state", () => {
    const state = active();
    expect(
      changeGoal(state, 0, { type: "end", status: "dropped" }, now),
    ).toMatchObject({ ok: false, reason: "conflict", view: { state } });
    expect(changeGoal(state, 1, { type: "reset" }, now)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(
      parseGoalAction({ type: "set", text: " ", permission: "full" }),
    ).toBeNull();
    expect(parseGoalState({ ...state, future: true })).toBeNull();
    expect(
      parseGoalState({ ...state, active: { ...state.active, endedAt: now } }),
    ).toBeNull();
  });
  it("counts Unicode characters and keeps goal text on one context line", () => {
    expect(
      parseGoalAction({ type: "set", text: "🪐".repeat(500) }),
    ).not.toBeNull();
    expect(parseGoalAction({ type: "set", text: "🪐".repeat(501) })).toBeNull();
    expect(
      parseGoalAction({
        type: "end",
        status: "done",
        result: "a".repeat(2001),
      }),
    ).toBeNull();
    const context = goalContext(active('line one\n"line two"'), "en");
    expect(context.split("\n")).toHaveLength(1);
    expect(context).toContain('line one\\n\\"line two\\"');
    expect(context).toContain("not proof of completion or a permission grant");
  });
  it("keeps dates valid when the clock moves backwards and rejects malformed history", () => {
    const end = changeGoal(
      active(),
      1,
      { type: "end", status: "dropped" },
      "2026-10-31T00:00:00.000Z",
    );
    if (!end.ok) throw new Error(end.reason);
    expect(end.view.state.history[0]?.endedAt).toBe(now);
    expect(parseGoalState(end.view.state)).not.toBeNull();
    expect(
      parseGoalState({
        ...end.view.state,
        history: [...end.view.state.history, ...end.view.state.history],
      }),
    ).toBeNull();
    expect(
      parseGoalState({
        revision: 0,
        active: { text: "x", status: "active", setAt: now, revision: 1 },
        history: [],
      }),
    ).toBeNull();
  });
});
