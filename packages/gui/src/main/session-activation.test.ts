import type { Session, SessionHost } from "@herta/app-server";
import { describe, expect, it, vi } from "vitest";
import { EVT } from "../preload/channels.js";
import { createSessionActivation } from "./session-activation.js";

/** A controllable host: each lifecycle call parks until the test settles it,
 *  and settling moves `activeSession` the way the real host does. */
function fakeHost() {
  const state: { active: Session | null } = { active: null };
  type Pending = {
    resolve: (s: Session) => void;
    reject: (e: unknown) => void;
  };
  const opens: Pending[] = [];
  const creates: Pending[] = [];
  let deleteImpl: (
    id: string,
  ) => Promise<{ ok: boolean; wasActive: boolean; removed?: boolean }> =
    async () => ({ ok: true, wasActive: false, removed: true });
  const host = {
    get activeSession() {
      return state.active;
    },
    openSession: () =>
      new Promise<Session>((resolve, reject) => {
        opens.push({ resolve, reject });
      }),
    createSession: () =>
      new Promise<Session>((resolve, reject) => {
        creates.push({ resolve, reject });
      }),
    deleteSession: (id: string) => deleteImpl(id),
  } as unknown as SessionHost;
  return {
    host,
    state,
    opens,
    creates,
    setDelete(impl: typeof deleteImpl) {
      deleteImpl = impl;
    },
  };
}

function session(id: string): Session {
  return { sessionId: id } as unknown as Session;
}

function setup() {
  const h = fakeHost();
  const sent: Array<[string, unknown]> = [];
  const activation = createSessionActivation({
    host: () => h.host,
    send: (ch, payload) => sent.push([ch, payload]),
    startForwarders: () => () => undefined,
    snapshot: (s) => ({ sessionId: s.sessionId }),
    lang: async () => "zh",
    log: () => undefined,
  });
  const resets = () =>
    sent.filter(([ch]) => ch === EVT.reset).map(([, p]) => p);
  return { h, sent, activation, resets };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("session activation — the window follows the host (UX review 2026-09-22, item 6)", () => {
  it("a superseded open followed by a FAILED newest open points the window at what the host kept", async () => {
    const { h, activation, resets } = setup();
    const x = session("X");
    h.state.active = x;
    activation.pointAt(x);
    // Click A (slow), then B (its file is corrupt).
    const pA = activation.openAndPoint("A");
    const pB = activation.openAndPoint("B");
    await flush();
    // The host opens A (closing X) — superseded, so it may not point.
    const a = session("A");
    h.state.active = a;
    h.opens[0]?.resolve(a);
    await pA;
    expect(activation.pointed).toBe(x);
    // B fails validation; the host keeps A.
    h.opens[1]?.reject(new Error("corrupt-line"));
    const rB = await pB;
    expect(rB).toMatchObject({ openError: { code: "unknown" } });
    // Pre-fix the window stayed on X — closed — with an enabled composer.
    expect(activation.pointed).toBe(a);
    expect(resets().at(-1)).toEqual({ sessionId: "A" });
  });

  it("a create that fails AFTER the host closed the open session points the window at nothing (the connect screen)", async () => {
    const { h, activation, resets } = setup();
    const x = session("X");
    h.state.active = x;
    activation.pointAt(x);
    const p = activation.createAndPoint({});
    await flush();
    h.state.active = null;
    h.creates[0]?.reject(new Error("SessionImpl.create failed"));
    expect(await p).toBeNull();
    expect(activation.pointed).toBeNull();
    expect(resets().at(-1)).toEqual({ noSession: true });
  });

  it("a create that fails BEFORE the close leaves the window where it is — no reset at all", async () => {
    const { h, activation, sent } = setup();
    const x = session("X");
    h.state.active = x;
    activation.pointAt(x);
    const before = sent.length;
    const p = activation.createAndPoint({});
    await flush();
    h.creates[0]?.reject(new Error("EACCES"));
    expect(await p).toBeNull();
    expect(activation.pointed).toBe(x);
    expect(sent.length).toBe(before);
  });

  it("a delete that closed the session but could not remove it blanks the window and keeps the card", async () => {
    const { h, activation, sent, resets } = setup();
    const x = session("X");
    h.state.active = x;
    activation.pointAt(x);
    h.setDelete(async () => {
      h.state.active = null;
      return { ok: false, wasActive: true, removed: false };
    });
    const r = await activation.deleteAndReconcile("X");
    expect(r).toEqual({ ok: false, wasActive: true });
    expect(activation.pointed).toBeNull();
    expect(resets().at(-1)).toEqual({ noSession: true });
    expect(sent.some(([ch]) => ch === EVT.sessionDeleted)).toBe(false);
  });

  it("a delete that removed the transcript but not its workspace folder still drops the card and blanks the window", async () => {
    const { h, activation, sent } = setup();
    const x = session("X");
    h.state.active = x;
    activation.pointAt(x);
    h.setDelete(async () => {
      h.state.active = null;
      return { ok: false, wasActive: true, removed: true };
    });
    await activation.deleteAndReconcile("X");
    expect(sent.at(-1)).toEqual([EVT.sessionDeleted, { sessionId: "X" }]);
    expect(activation.pointed).toBeNull();
  });

  it("a delete that THROWS is answered, not rejected, and the window still follows the host", async () => {
    const { h, activation, resets } = setup();
    const x = session("X");
    h.state.active = x;
    activation.pointAt(x);
    h.setDelete(async () => {
      h.state.active = null;
      throw new Error("close failed");
    });
    await expect(activation.deleteAndReconcile("X")).resolves.toEqual({
      ok: false,
      wasActive: false,
    });
    expect(resets().at(-1)).toEqual({ noSession: true });
  });

  it("a page that asks for its state gets the open session again, or the connect screen — and nothing before the host exists (the reload re-sync, item 7)", () => {
    const { h, activation, resets } = setup();
    // The host is up with a session open: the reloaded page's ask re-points.
    const x = session("X");
    h.state.active = x;
    activation.resync();
    expect(resets().at(-1)).toEqual({ sessionId: "X" });
    expect(activation.pointed).toBe(x);
    // Nothing open: the connect station.
    h.state.active = null;
    activation.resync();
    expect(resets().at(-1)).toEqual({ noSession: true });
    // Before bootstrap there is no host: silent.
    const sent: unknown[] = [];
    const early = createSessionActivation({
      host: () => null,
      send: (ch, p) => sent.push([ch, p]),
      startForwarders: () => () => undefined,
      snapshot: (s) => ({ sessionId: s.sessionId }),
      lang: async () => "zh",
    });
    early.resync();
    expect(sent).toEqual([]);
  });

  it("opening and reload restore history without regenerating an orphaned reply; a new session still plays its opening", async () => {
    const { h, activation } = setup();
    const regen = vi.fn(async () => undefined);
    const opening = vi.fn(async () => undefined);
    const p = activation.openAndPoint("A");
    await flush();
    const a = {
      sessionId: "A",
      regenerateLastReplyIfOrphaned: regen,
    } as unknown as Session;
    h.state.active = a;
    h.opens[0]?.resolve(a);
    await p;
    expect(activation.pointed).toBe(a);
    expect(regen).not.toHaveBeenCalled();
    activation.resync();
    expect(activation.pointed).toBe(a);
    expect(regen).not.toHaveBeenCalled();
    const c = activation.createAndPoint({});
    await flush();
    const n = { sessionId: "N", playOpening: opening } as unknown as Session;
    h.state.active = n;
    h.creates[0]?.resolve(n);
    await c;
    expect(activation.pointed).toBe(n);
    expect(opening).toHaveBeenCalledTimes(1);
  });
});
