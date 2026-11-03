import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  changeGoal,
  emptyGoalState,
  type GoalAction,
  type GoalReply,
  goalContext,
  parseGoalAction,
  parseGoalState,
  writeFileAtomicSync,
} from "@herta/core";

const MAX_GOAL_BYTES = 16 * 1024 * 1024;

/** F09: goal data belongs to the record-store anchor, never the movable project. */
export class SessionGoalStore {
  constructor(
    private readonly root: string,
    private readonly sessionId: string,
  ) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId))
      throw new Error("Invalid session ID");
  }

  /** Reject every linked component before reading, writing or removing a sidecar. */
  private path(create = false): string {
    let dir = realpathSync(this.root);
    for (const part of [".herta", "goals"]) {
      dir = join(dir, part);
      try {
        const info = lstatSync(dir);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error("Unsafe goal directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (create) mkdirSync(dir);
      }
    }
    const file = join(dir, `${this.sessionId}.json`);
    try {
      const info = lstatSync(file);
      if (info.isSymbolicLink() || !info.isFile())
        throw new Error("Unsafe goal file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return file;
  }

  read(): GoalReply {
    let file: string;
    try {
      file = this.path();
    } catch {
      return { ok: false, reason: "storage" };
    }
    let raw: string;
    try {
      if (lstatSync(file).size > MAX_GOAL_BYTES) return this.damaged();
      raw = readFileSync(file, "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { ok: true, view: { state: emptyGoalState() } }
        : { ok: false, reason: "storage" };
    }
    try {
      const data = JSON.parse(raw) as {
        version?: unknown;
        sessionId?: unknown;
        state?: unknown;
      };
      const state =
        data?.version === 1 &&
        data.sessionId === this.sessionId &&
        Object.keys(data).every((key) =>
          ["version", "sessionId", "state"].includes(key),
        )
          ? parseGoalState(data.state)
          : null;
      return state === null ? this.damaged() : { ok: true, view: { state } };
    } catch {
      return this.damaged();
    }
  }

  private damaged(): GoalReply {
    return { ok: true, view: { state: emptyGoalState(), damaged: true } };
  }

  update(expectedRevision: number, action: GoalAction): GoalReply {
    const parsed = parseGoalAction(action);
    if (
      parsed === null ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0
    )
      return { ok: false, reason: "invalid" };
    const current = this.read();
    if (parsed.type === "reset") {
      // Reset only a damaged file, explicitly requested by the owner. Preserve its bytes.
      if (!current.ok || !current.view.damaged)
        return current.ok
          ? { ok: false, reason: "invalid", view: current.view }
          : current;
      if (expectedRevision !== 0)
        return { ok: false, reason: "conflict", view: current.view };
      try {
        const file = this.path();
        renameSync(file, `${file}.damaged-${randomUUID()}`);
        return { ok: true, view: { state: emptyGoalState() } };
      } catch {
        return { ok: false, reason: "storage", view: current.view };
      }
    }
    if (!current.ok) return current;
    if (current.view.damaged)
      return { ok: false, reason: "damaged", view: current.view };
    const next = changeGoal(
      current.view.state,
      expectedRevision,
      parsed,
      new Date().toISOString(),
    );
    if (!next.ok) return next;
    if (next.view.state.revision === current.view.state.revision) return next;
    const serialized = JSON.stringify({
      version: 1,
      sessionId: this.sessionId,
      state: next.view.state,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_GOAL_BYTES)
      return { ok: false, reason: "history_full", view: current.view };
    try {
      writeFileAtomicSync(this.path(true), serialized, { fsync: true });
      return next;
    } catch {
      return { ok: false, reason: "storage", view: current.view };
    }
  }

  context(lang: "zh" | "en"): string {
    const current = this.read();
    if (!current.ok || current.view.damaged)
      throw Object.assign(
        new Error(
          "The session goal record cannot be read; restore it before sending.",
        ),
        { code: "goal-damaged" },
      );
    return goalContext(current.view.state, lang);
  }

  /** Damaged backups deliberately remain available for recovery after task deletion. */
  remove(): void {
    try {
      unlinkSync(this.path());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
