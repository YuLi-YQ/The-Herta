import {
  type CompactAction,
  type CompactReply,
  parseCompactAction,
} from "@herta/core";

interface CompactTarget {
  readonly sessionId: string;
  getCompact?(): CompactReply;
  updateCompact?(revision: number, action: CompactAction): CompactReply;
}
const idOf = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const safe = (run: () => CompactReply): CompactReply => {
  try {
    return run();
  } catch {
    return { ok: false, reason: "unavailable" };
  }
};

/** Only the active task owns this request; scheduling never submits a model turn. */
export function createCompactCommands(
  active: () => CompactTarget | null,
  changingTask: () => boolean = () => false,
) {
  return {
    getSessionCompact(id: unknown): CompactReply {
      if (!idOf(id)) return { ok: false, reason: "no_target" };
      return safe(() => {
        const target = active();
        if (!target || target.sessionId !== id)
          return { ok: false, reason: "no_target" };
        return target.getCompact?.() ?? { ok: false, reason: "unavailable" };
      });
    },
    updateSessionCompact(
      id: unknown,
      revision: unknown,
      input: unknown,
    ): CompactReply {
      if (!idOf(id)) return { ok: false, reason: "no_target" };
      const action = parseCompactAction(input);
      if (
        !action ||
        !Number.isSafeInteger(revision) ||
        (revision as number) < 0
      )
        return { ok: false, reason: "invalid" };
      return safe(() => {
        if (changingTask()) return { ok: false, reason: "busy" };
        const target = active();
        if (!target || target.sessionId !== id)
          return { ok: false, reason: "no_target" };
        return (
          target.updateCompact?.(revision as number, action) ?? {
            ok: false,
            reason: "unavailable",
          }
        );
      });
    },
  };
}
