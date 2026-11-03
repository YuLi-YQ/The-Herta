import { expect, it } from "vitest";
import {
  capturePlan,
  changePlan,
  emptyPlanState,
  parsePlanAction,
  parsePlanState,
  planContext,
} from "./session-plan.js";
const now = "2026-11-01T03:00:00.000Z";
const enter = () => {
  const r = changePlan(
    emptyPlanState(),
    0,
    { type: "enter" },
    now,
    "full-access",
  );
  if (!r.ok) throw Error(r.reason);
  return r.view.state;
};
it("requires explicit full-access confirmation and preserves the saved plan across exit", () => {
  const active = enter();
  expect(planContext(active, "zh")).toContain("只读");
  const captured = capturePlan(
    active,
    1,
    "1. Inspect\n2. Change after approval",
    "turn-1",
    now,
  );
  if (!captured.ok) throw Error(captured.reason);
  expect(
    changePlan(captured.view.state, 2, { type: "exit" }, now),
  ).toMatchObject({ ok: false, reason: "confirmation_required" });
  const out = changePlan(
    captured.view.state,
    2,
    { type: "exit", confirmFullAccess: true },
    now,
  );
  expect(out).toMatchObject({
    ok: true,
    restoredMode: "full-access",
    view: {
      locked: false,
      state: { plan: { text: "1. Inspect\n2. Change after approval" } },
    },
  });
  if (out.ok) {
    expect(planContext(out.view.state, "en")).toBe("");
    expect(parsePlanState(out.view.state)).toEqual(out.view.state);
  }
});
it("keeps revisions for model capture and user edits, refusing stale completions", () => {
  const first = capturePlan(enter(), 1, "First", "turn-1", now);
  if (!first.ok) throw Error(first.reason);
  const edit = changePlan(
    first.view.state,
    2,
    { type: "save", text: "User revised" },
    now,
  );
  if (!edit.ok) throw Error(edit.reason);
  expect(edit.view.state.history).toMatchObject([
    { text: "First", source: "model", turnId: "turn-1" },
  ]);
  expect(edit.view.state.plan).toMatchObject({
    text: "User revised",
    source: "user",
    revision: 3,
  });
  expect(planContext(edit.view.state, "zh")).toContain(
    JSON.stringify("User revised"),
  );
  expect(planContext(edit.view.state, "en")).toContain(
    "not permission to execute",
  );
  expect(
    capturePlan(edit.view.state, 2, "Late reply", "turn-2", now),
  ).toMatchObject({ ok: false, reason: "conflict" });
  expect(parsePlanState(edit.view.state)).not.toBeNull();
});
it("treats inputs as data and rejects forged privileges or damaged state", () => {
  expect(
    parsePlanAction({ type: "enter", previousMode: "full-access" }),
  ).toBeNull();
  expect(
    parsePlanAction({ type: "exit", confirmFullAccess: "yes" }),
  ).toBeNull();
  expect(
    parsePlanAction({ type: "save", text: "🪐".repeat(32000) }),
  ).not.toBeNull();
  expect(parsePlanAction({ type: "save", text: "x".repeat(32001) })).toBeNull();
  expect(parsePlanState({ ...emptyPlanState(), active: true })).toBeNull();
  expect(parsePlanState({ ...enter(), future: true })).toBeNull();
  expect(changePlan(enter(), 1, { type: "reset" }, now)).toMatchObject({
    ok: false,
    reason: "invalid",
  });
});
it("accepts only a trusted lower restoration mode after a grant was revoked", () => {
  const result = changePlan(enter(), 1, { type: "exit" }, now, "read-only");
  expect(result).toMatchObject({
    ok: true,
    restoredMode: "read-only",
    view: { locked: false },
  });
});
it("refuses a full revision history without dropping earlier plans", () => {
  let state = enter();
  for (let index = 0; index <= 100; index++) {
    const saved = changePlan(
      state,
      state.revision,
      { type: "save", text: `Plan ${index}` },
      now,
    );
    if (!saved.ok) throw Error(saved.reason);
    state = saved.view.state;
  }
  expect(state.history).toHaveLength(100);
  expect(
    changePlan(state, state.revision, { type: "save", text: "One more" }, now),
  ).toMatchObject({ ok: false, reason: "history_full", view: { state } });
  expect(state.history[0]?.text).toBe("Plan 0");
  expect(
    changePlan(
      state,
      state.revision,
      { type: "exit", confirmFullAccess: true },
      now,
    ),
  ).toMatchObject({ ok: true, view: { locked: false } });
});
