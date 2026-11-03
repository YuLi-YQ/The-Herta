import type { PermissionMode } from "./types/tool.js";

export const PLAN_TEXT_LIMIT = 32000;
export const PLAN_HISTORY_LIMIT = 100;
export interface PlanContent {
  readonly text: string;
  readonly updatedAt: string;
  readonly turnId?: string;
  readonly source: "model" | "user";
  readonly revision: number;
}
export interface PlanState {
  readonly revision: number;
  readonly active: boolean;
  readonly previousMode: PermissionMode | null;
  readonly plan: PlanContent | null;
  readonly history: readonly PlanContent[];
}
export interface PlanView {
  readonly state: PlanState;
  readonly locked: boolean;
  readonly damaged?: true;
  readonly saveError?: "storage" | "conflict" | "invalid" | "history_full";
}
export type PlanFailure =
  | "no_target"
  | "busy"
  | "conflict"
  | "damaged"
  | "storage"
  | "invalid"
  | "confirmation_required"
  | "history_full"
  | "unavailable";
export type PlanReply =
  | {
      readonly ok: true;
      readonly view: PlanView;
      readonly restoredMode?: PermissionMode;
    }
  | {
      readonly ok: false;
      readonly reason: PlanFailure;
      readonly view?: PlanView;
    };
export type PlanAction =
  | { readonly type: "enter" }
  | { readonly type: "exit"; readonly confirmFullAccess?: boolean }
  | { readonly type: "save"; readonly text: string }
  | { readonly type: "reset" };
export const emptyPlanState = (): PlanState => ({
  revision: 0,
  active: false,
  previousMode: null,
  plan: null,
  history: [],
});
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(v).every((k) => names.includes(k));
const revision = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;
const mode = (v: unknown): v is PermissionMode =>
  v === "read-only" || v === "workspace-edit" || v === "full-access";
const bounded = (v: unknown): v is string =>
  typeof v === "string" &&
  !v.includes("\0") &&
  Array.from(v).length <= PLAN_TEXT_LIMIT &&
  v.trim().length > 0;
const date = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v));
const content = (v: unknown, rev: number): v is PlanContent =>
  object(v) &&
  keys(v, ["text", "updatedAt", "turnId", "source", "revision"]) &&
  bounded(v.text) &&
  date(v.updatedAt) &&
  revision(v.revision) &&
  v.revision > 0 &&
  v.revision <= rev &&
  (v.source === "model" || v.source === "user") &&
  (v.turnId === undefined ||
    (typeof v.turnId === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(v.turnId))) &&
  (v.source !== "model" || v.turnId !== undefined);

/** Unknown/future data is preserved by the host and never treated as permission to unlock. */
export function parsePlanState(value: unknown): PlanState | null {
  if (
    !object(value) ||
    !keys(value, ["revision", "active", "previousMode", "plan", "history"]) ||
    !revision(value.revision) ||
    typeof value.active !== "boolean" ||
    (value.active ? !mode(value.previousMode) : value.previousMode !== null) ||
    !(value.plan === null || content(value.plan, value.revision)) ||
    !Array.isArray(value.history) ||
    value.history.length > PLAN_HISTORY_LIMIT
  )
    return null;
  let last = 0;
  for (const item of value.history) {
    if (!content(item, value.revision) || item.revision <= last) return null;
    last = item.revision;
  }
  if (
    value.history.length &&
    (value.plan === null || (value.plan as PlanContent).revision <= last)
  )
    return null;
  return {
    revision: value.revision,
    active: value.active,
    previousMode: value.previousMode as PermissionMode | null,
    plan: value.plan as PlanContent | null,
    history: value.history as PlanContent[],
  };
}
export function parsePlanAction(value: unknown): PlanAction | null {
  if (!object(value)) return null;
  if (
    (value.type === "enter" || value.type === "reset") &&
    keys(value, ["type"])
  )
    return { type: value.type };
  if (
    value.type === "exit" &&
    keys(value, ["type", "confirmFullAccess"]) &&
    (value.confirmFullAccess === undefined ||
      typeof value.confirmFullAccess === "boolean")
  )
    return {
      type: "exit",
      ...(value.confirmFullAccess === undefined
        ? {}
        : { confirmFullAccess: value.confirmFullAccess }),
    };
  if (
    value.type === "save" &&
    keys(value, ["type", "text"]) &&
    bounded(value.text)
  )
    return { type: "save", text: value.text.trim() };
  return null;
}
const viewOf = (state: PlanState): PlanView => ({
  state,
  locked: state.active,
});
function replacePlan(
  state: PlanState,
  text: string,
  source: PlanContent["source"],
  now: string,
  turnId?: string,
): PlanReply {
  if (
    !bounded(text) ||
    !date(now) ||
    state.revision === Number.MAX_SAFE_INTEGER ||
    (source === "model" && (!turnId || !/^[A-Za-z0-9_-]{1,128}$/.test(turnId)))
  )
    return { ok: false, reason: "invalid", view: viewOf(state) };
  if (
    state.plan?.text === text &&
    (source === "user" || state.plan.turnId === turnId)
  )
    return { ok: true, view: viewOf(state) };
  if (state.plan && state.history.length >= PLAN_HISTORY_LIMIT)
    return { ok: false, reason: "history_full", view: viewOf(state) };
  const rev = state.revision + 1;
  return {
    ok: true,
    view: viewOf({
      ...state,
      revision: rev,
      plan: {
        text: text.trim(),
        updatedAt: now,
        source,
        revision: rev,
        ...(turnId ? { turnId } : {}),
      },
      history: state.plan ? [...state.history, state.plan] : state.history,
    }),
  };
}
/** Pure transition only. The host restores trusted grants BEFORE persisting an exit. */
export function changePlan(
  state: PlanState,
  expected: number,
  input: PlanAction,
  now: string,
  trustedMode?: PermissionMode,
): PlanReply {
  const view = viewOf(state),
    action = parsePlanAction(input);
  if (
    !revision(expected) ||
    !action ||
    action.type === "reset" ||
    !date(now) ||
    state.revision === Number.MAX_SAFE_INTEGER
  )
    return { ok: false, reason: "invalid", view };
  if (expected !== state.revision)
    return { ok: false, reason: "conflict", view };
  if (action.type === "enter") {
    if (state.active || !mode(trustedMode))
      return { ok: false, reason: "invalid", view };
    return {
      ok: true,
      view: viewOf({
        ...state,
        revision: state.revision + 1,
        active: true,
        previousMode: trustedMode,
      }),
    };
  }
  if (action.type === "exit") {
    if (!state.active) return { ok: false, reason: "invalid", view };
    const restoredMode = trustedMode ?? state.previousMode;
    if (!mode(restoredMode)) return { ok: false, reason: "invalid", view };
    if (restoredMode === "full-access" && action.confirmFullAccess !== true)
      return { ok: false, reason: "confirmation_required", view };
    return {
      ok: true,
      view: viewOf({
        ...state,
        revision: state.revision + 1,
        active: false,
        previousMode: null,
      }),
      restoredMode,
    };
  }
  return replacePlan(state, action.text, "user", now);
}
/** Only a successful planning turn's final reply is captured; models cannot enter or exit the mode. */
export function capturePlan(
  state: PlanState,
  expected: number,
  text: string,
  turnId: string,
  now: string,
): PlanReply {
  if (!state.active || !revision(expected))
    return { ok: false, reason: "invalid", view: viewOf(state) };
  if (expected !== state.revision)
    return { ok: false, reason: "conflict", view: viewOf(state) };
  return replacePlan(state, text, "model", now, turnId);
}
export function planContext(state: PlanState, lang: "zh" | "en"): string {
  if (!state.active) return "";
  const instruction =
    lang === "zh"
      ? "计划模式：只读取并给出计划，不修改文件、不运行写入命令；委派给执行模型也必须只读。最后回复提供可供用户检查的计划。是否退出计划模式由用户决定。"
      : "Plan mode: inspect and propose a plan only. Do not edit files or run write commands; delegated execution is read-only too. Give the reviewable plan in the final reply. Only the user decides when to leave plan mode.";
  return state.plan
    ? `${instruction}\n${lang === "zh" ? "当前保存的计划（仅供参考，不授予执行权限）" : "Current saved plan (reference only, not permission to execute)"}: ${JSON.stringify(state.plan.text)}`
    : instruction;
}
