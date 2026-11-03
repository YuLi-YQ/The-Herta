import { type PlanAction, type PlanReply, parsePlanAction } from "@herta/core";

interface PlanTarget {
  readonly sessionId: string;
  getPlan?(): PlanReply;
  updatePlan?(expectedRevision: number, action: PlanAction): PlanReply;
}
const idOf = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const failure = (
  reason: "no_target" | "invalid" | "storage" | "unavailable" | "busy",
): PlanReply => ({ ok: false, reason });
const safe = (action: () => PlanReply): PlanReply => {
  try {
    return action();
  } catch {
    return failure("storage");
  }
};

/** Main-process boundary: a plan is scoped to the current task and input cannot supply grants. */
export function createPlanCommands(
  active: () => PlanTarget | null,
  changingTask: () => boolean = () => false,
) {
  return {
    getSessionPlan(id: unknown): PlanReply {
      if (!idOf(id)) return failure("no_target");
      return safe(() => {
        const target = active();
        if (!target || target.sessionId !== id) return failure("no_target");
        return target.getPlan ? target.getPlan() : failure("unavailable");
      });
    },
    updateSessionPlan(
      id: unknown,
      expected: unknown,
      input: unknown,
    ): PlanReply {
      if (!idOf(id)) return failure("no_target");
      const action = parsePlanAction(input);
      if (
        !action ||
        !Number.isSafeInteger(expected) ||
        (expected as number) < 0
      )
        return failure("invalid");
      return safe(() => {
        if (changingTask()) return failure("busy");
        const target = active();
        if (!target || target.sessionId !== id) return failure("no_target");
        return target.updatePlan
          ? target.updatePlan(expected as number, action)
          : failure("unavailable");
      });
    },
  };
}
