/** User-owned conversation goals (F09). Data only: they grant no tool permissions. */
export const GOAL_TEXT_LIMIT = 500;
export const GOAL_RESULT_LIMIT = 2000;
export const GOAL_HISTORY_LIMIT = 1000;
export interface GoalEntry {
  readonly text: string;
  readonly status: "active" | "done" | "dropped";
  readonly result?: string;
  readonly setAt: string;
  readonly endedAt?: string;
  readonly revision: number;
}
export interface GoalState {
  readonly revision: number;
  readonly active: GoalEntry | null;
  readonly history: readonly GoalEntry[];
}
export interface GoalView {
  readonly state: GoalState;
  readonly damaged?: true;
}
export type GoalFailure =
  | "no_target"
  | "busy"
  | "conflict"
  | "damaged"
  | "storage"
  | "invalid"
  | "history_full";
export type GoalReply =
  | { readonly ok: true; readonly view: GoalView }
  | {
      readonly ok: false;
      readonly reason: GoalFailure;
      readonly view?: GoalView;
    };
export type GoalAction =
  | { readonly type: "set"; readonly text: string }
  | {
      readonly type: "end";
      readonly status: "done" | "dropped";
      readonly result?: string;
    }
  | { readonly type: "reset" };

export const emptyGoalState = (): GoalState => ({
  revision: 0,
  active: null,
  history: [],
});
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
const revision = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;
const bounded = (v: unknown, max: number): v is string =>
  typeof v === "string" && !v.includes("\0") && Array.from(v).length <= max;
const date = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v));
function entry(
  v: unknown,
  active: boolean,
  currentRevision: number,
): v is GoalEntry {
  if (
    !object(v) ||
    !keys(v, ["text", "status", "result", "setAt", "endedAt", "revision"]) ||
    !bounded(v.text, GOAL_TEXT_LIMIT) ||
    !v.text.trim() ||
    !date(v.setAt) ||
    !revision(v.revision) ||
    v.revision === 0 ||
    v.revision > currentRevision
  )
    return false;
  if (active)
    return (
      v.status === "active" && v.result === undefined && v.endedAt === undefined
    );
  return (
    (v.status === "done" || v.status === "dropped") &&
    date(v.endedAt) &&
    Date.parse(v.endedAt) >= Date.parse(v.setAt) &&
    (v.result === undefined || bounded(v.result, GOAL_RESULT_LIMIT))
  );
}
/** Strictly reject damaged/future records; callers preserve their original bytes for explicit recovery. */
export function parseGoalState(value: unknown): GoalState | null {
  if (
    !object(value) ||
    !keys(value, ["revision", "active", "history"]) ||
    !revision(value.revision) ||
    !Array.isArray(value.history) ||
    value.history.length > GOAL_HISTORY_LIMIT ||
    !(value.active === null || entry(value.active, true, value.revision))
  )
    return null;
  let last = 0;
  for (const item of value.history) {
    if (!entry(item, false, value.revision) || item.revision <= last)
      return null;
    last = item.revision;
  }
  if (value.active !== null && (value.active as GoalEntry).revision <= last)
    return null;
  return {
    revision: value.revision,
    active: value.active as GoalEntry | null,
    history: value.history as GoalEntry[],
  };
}
export function parseGoalAction(value: unknown): GoalAction | null {
  if (!object(value)) return null;
  if (value.type === "reset" && keys(value, ["type"])) return { type: "reset" };
  if (
    value.type === "set" &&
    keys(value, ["type", "text"]) &&
    bounded(value.text, GOAL_TEXT_LIMIT) &&
    value.text.trim()
  )
    return { type: "set", text: value.text.trim() };
  if (
    value.type === "end" &&
    keys(value, ["type", "status", "result"]) &&
    (value.status === "done" || value.status === "dropped") &&
    (value.result === undefined || bounded(value.result, GOAL_RESULT_LIMIT))
  )
    return {
      type: "end",
      status: value.status,
      ...(typeof value.result === "string" && value.result.trim()
        ? { result: value.result.trim() }
        : {}),
    };
  return null;
}
/** Pure CAS transition. Recovery is intentionally a host operation, after preserving damaged storage. */
export function changeGoal(
  state: GoalState,
  expectedRevision: number,
  input: GoalAction,
  now: string,
): GoalReply {
  const view = { state };
  const action = parseGoalAction(input);
  if (
    !revision(expectedRevision) ||
    !action ||
    action.type === "reset" ||
    !date(now)
  )
    return { ok: false, reason: "invalid", view };
  if (expectedRevision !== state.revision)
    return { ok: false, reason: "conflict", view };
  if (state.revision === Number.MAX_SAFE_INTEGER)
    return { ok: false, reason: "invalid", view };
  const next = state.revision + 1;
  if (action.type === "set") {
    if (state.active?.text === action.text) return { ok: true, view };
    if (!state.active && state.history.length >= GOAL_HISTORY_LIMIT)
      return { ok: false, reason: "history_full", view };
    return {
      ok: true,
      view: {
        state: {
          ...state,
          revision: next,
          active: {
            text: action.text,
            status: "active",
            setAt: state.active?.setAt ?? now,
            revision: next,
          },
        },
      },
    };
  }
  if (!state.active) return { ok: false, reason: "invalid", view };
  if (state.history.length >= GOAL_HISTORY_LIMIT)
    return { ok: false, reason: "history_full", view };
  // A clock adjustment must not turn a saved goal into a record the reader rejects.
  const endedAt =
    Date.parse(now) < Date.parse(state.active.setAt) ? state.active.setAt : now;
  return {
    ok: true,
    view: {
      state: {
        revision: next,
        active: null,
        history: [
          ...state.history,
          {
            ...state.active,
            status: action.status,
            endedAt,
            revision: next,
            ...(action.result ? { result: action.result } : {}),
          },
        ],
      },
    },
  };
}
/** A bounded single line outside the cached persona prefix. Only active goals enter a request. */
export function goalContext(state: GoalState, lang: "zh" | "en"): string {
  if (!state.active) return "";
  const label =
    lang === "zh"
      ? "用户设定的当前目标（仅作上下文，不代表已完成或新增权限；只有用户能标记完成）"
      : "Current user-set goal (context only, not proof of completion or a permission grant; only the user may mark it complete)";
  return `${label}: ${JSON.stringify(state.active.text)}`;
}
