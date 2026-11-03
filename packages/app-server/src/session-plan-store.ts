import { randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  emptyPlanState,
  type PlanReply,
  type PlanState,
  parsePlanState,
  writeFileAtomicSync,
} from "@herta/core";

const MAX_PLAN_BYTES = 32 * 1024 * 1024;
const lockedError = (reason: "storage" | "damaged"): PlanReply =>
  reason === "damaged"
    ? {
        ok: true,
        view: { state: emptyPlanState(), locked: true, damaged: true },
      }
    : { ok: false, reason, view: { state: emptyPlanState(), locked: true } };

/** Plan state is an application record beside the transcript, not project instructions. */
export class SessionPlanStore {
  constructor(
    private readonly root: string,
    private readonly sessionId: string,
  ) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId))
      throw new Error("Invalid session ID");
  }
  private path(create = false): string {
    let dir = realpathSync(this.root);
    for (const part of [".herta", "plans"]) {
      dir = join(dir, part);
      try {
        const info = lstatSync(dir);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error("Unsafe plan directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (create) mkdirSync(dir);
      }
    }
    const path = join(dir, `${this.sessionId}.json`);
    try {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile())
        throw new Error("Unsafe plan file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return path;
  }
  read(): PlanReply {
    let path: string;
    try {
      path = this.path();
    } catch {
      return lockedError("storage");
    }
    let raw: string;
    try {
      if (lstatSync(path).size > MAX_PLAN_BYTES) return lockedError("damaged");
      raw = readFileSync(path, "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { ok: true, view: { state: emptyPlanState(), locked: false } }
        : lockedError("storage");
    }
    try {
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        sessionId?: unknown;
        state?: unknown;
      };
      const state =
        parsed?.version === 1 &&
        parsed.sessionId === this.sessionId &&
        Object.keys(parsed).every((key) =>
          ["version", "sessionId", "state"].includes(key),
        )
          ? parsePlanState(parsed.state)
          : null;
      return state
        ? { ok: true, view: { state, locked: state.active } }
        : lockedError("damaged");
    } catch {
      return lockedError("damaged");
    }
  }
  /** Recheck CAS after permission restoration, before one atomic sidecar replacement. */
  commit(expectedRevision: number, next: PlanState): PlanReply {
    const current = this.read();
    if (!current.ok) return current;
    if (current.view.damaged)
      return { ok: false, reason: "damaged", view: current.view };
    if (current.view.state.revision !== expectedRevision)
      return { ok: false, reason: "conflict", view: current.view };
    if (!parsePlanState(next))
      return { ok: false, reason: "invalid", view: current.view };
    if (next.revision === current.view.state.revision) return current;
    return this.write(next, current.view);
  }
  reset(expectedRevision: number): PlanReply {
    const current = this.read();
    if (!current.ok) return current;
    if (!current.view.damaged)
      return { ok: false, reason: "invalid", view: current.view };
    if (expectedRevision !== 0)
      return { ok: false, reason: "conflict", view: current.view };
    try {
      const file = this.path();
      // Copy, never rename: failure after the backup must leave the original lock in place.
      copyFileSync(
        file,
        `${file}.damaged-${randomUUID()}`,
        constants.COPYFILE_EXCL,
      );
      const state: PlanState = {
        ...emptyPlanState(),
        active: true,
        previousMode: "read-only",
        revision: 1,
      };
      return this.write(state, current.view);
    } catch {
      return { ok: false, reason: "storage", view: current.view };
    }
  }
  private write(
    state: PlanState,
    previous: NonNullable<PlanReply["view"]>,
  ): PlanReply {
    const serialized = JSON.stringify({
      version: 1,
      sessionId: this.sessionId,
      state,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_PLAN_BYTES)
      return { ok: false, reason: "history_full", view: previous };
    try {
      writeFileAtomicSync(this.path(true), serialized, { fsync: true });
      return { ok: true, view: { state, locked: state.active } };
    } catch {
      return { ok: false, reason: "storage", view: previous };
    }
  }
  /** Keep isolated damaged backups after task deletion. */
  remove(): void {
    try {
      unlinkSync(this.path());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
