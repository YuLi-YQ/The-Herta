import { type GoalAction, type GoalReply, parseGoalAction } from "@herta/core";

interface GoalTarget {
  readonly sessionId: string;
  getGoal?(): GoalReply;
  updateGoal?(expectedRevision: number, action: GoalAction): GoalReply;
}
interface GoalCommandDeps {
  session(): GoalTarget | null;
  chat: {
    getGoal(id: string): GoalReply;
    updateGoal(
      id: string,
      expectedRevision: number,
      action: GoalAction,
    ): GoalReply;
  };
}
const idOf = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const failure = (reason: "no_target" | "invalid" | "storage"): GoalReply => ({
  ok: false,
  reason,
});
const safe = (read: () => GoalReply): GoalReply => {
  try {
    return read();
  } catch {
    return failure("storage");
  }
};
/** IPC is an untrusted input boundary, even when the visible panel validated its form. */
export function createGoalCommands(deps: GoalCommandDeps) {
  const change = (
    id: unknown,
    expected: unknown,
    value: unknown,
    run: (id: string, revision: number, action: GoalAction) => GoalReply,
  ): GoalReply => {
    if (!idOf(id)) return failure("no_target");
    const action = parseGoalAction(value);
    if (!Number.isSafeInteger(expected) || (expected as number) < 0 || !action)
      return failure("invalid");
    return safe(() => run(id, expected as number, action));
  };
  return {
    getSessionGoal(id: unknown): GoalReply {
      if (!idOf(id)) return failure("no_target");
      return safe(() => {
        const session = deps.session();
        return session?.sessionId === id && session.getGoal
          ? session.getGoal()
          : failure("no_target");
      });
    },
    updateSessionGoal(
      id: unknown,
      expected: unknown,
      value: unknown,
    ): GoalReply {
      return change(id, expected, value, (target, revision, action) => {
        const session = deps.session();
        return session?.sessionId === target && session.updateGoal
          ? session.updateGoal(revision, action)
          : failure("no_target");
      });
    },
    getChatGoal(id: unknown): GoalReply {
      return idOf(id)
        ? safe(() => deps.chat.getGoal(id))
        : failure("no_target");
    },
    updateChatGoal(id: unknown, expected: unknown, value: unknown): GoalReply {
      return change(id, expected, value, (target, revision, action) =>
        deps.chat.updateGoal(target, revision, action),
      );
    },
  };
}
