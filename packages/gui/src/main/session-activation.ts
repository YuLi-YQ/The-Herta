import type {
  CreateSessionOpts,
  OpenSessionOpts,
  Session,
  SessionHost,
} from "@herta/app-server";
import { SessionFileError } from "@herta/core";
import { EVT } from "../preload/channels.js";
import type { SessionOpenFailure } from "../renderer/ipc/bridge-types.js";

type Send = (channel: string, payload: unknown) => void;
type Lang = NonNullable<OpenSessionOpts["lang"]>;

export interface SessionActivationDeps {
  /** The host, once bootstrap has made one. */
  readonly host: () => SessionHost | null;
  readonly send: Send;
  readonly startForwarders: (session: Session, send: Send) => () => void;
  /** The reset payload for a session the window is pointed at. */
  readonly snapshot: (session: Session) => unknown;
  /** The interaction language, resolved fresh per activation. */
  readonly lang: () => Promise<Lang>;
  readonly log?: (message: string, err: unknown) => void;
}

export interface SessionActivation {
  /** The session the window shows — the one whose forwarders run. */
  readonly pointed: Session | null;
  pointAt(session: Session): void;
  /** The window shows nothing: the connect screen. */
  pointNowhere(): void;
  /** Stop forwarding without telling the window (dispose). */
  release(): void;
  /** The window asks for its state (its store just subscribed): point it
   *  at the host's open session again, or at nothing. Before the host
   *  exists there is nothing to say — the bootstrap's own reset follows. */
  resync(): void;
  openAndPoint(id: string): Promise<Session | SessionOpenFailure | null>;
  createAndPoint(opts: CreateSessionOpts): Promise<Session | null>;
  deleteAndReconcile(
    id: string,
  ): Promise<{ readonly ok: boolean; readonly wasActive: boolean }>;
}

/**
 * Which session the window shows, and the three calls that change it (open,
 * create, delete). Its one rule: after any of them settles — resolved OR
 * thrown — the window shows the session the host has open, or nothing;
 * never one the host closed (UX review 2026-09-22, item 6). Three paths
 * used to break it and leave the composer enabled on a closed session, every
 * send going nowhere: a superseded open (click A, then B whose file is
 * corrupt — the host kept A, the window kept the session A had closed), a
 * create that failed after the close, a delete that failed after it.
 *
 * Last-CLICK-wins ordering, shared by the renderer's IPC handlers and the
 * tray menu: activations run concurrently, and only the newest may point
 * the window. A superseded one still resolves (harmless) but never
 * re-points — the reconcile after the newest one settles does.
 */
export function createSessionActivation(
  deps: SessionActivationDeps,
): SessionActivation {
  const log =
    deps.log ?? ((message, err) => console.error(`[herta] ${message}`, err));
  let stopForwarders: (() => void) | null = null;
  let pointed: Session | null = null;
  let activationSeq = 0;

  function pointAt(session: Session): void {
    stopForwarders?.();
    stopForwarders = deps.startForwarders(session, deps.send);
    pointed = session;
    deps.send(EVT.reset, deps.snapshot(session));
  }

  function release(): void {
    stopForwarders?.();
    stopForwarders = null;
    pointed = null;
  }

  function pointNowhere(): void {
    release();
    deps.send(EVT.reset, { noSession: true });
  }

  /** A reloaded page subscribes AFTER main's did-finish-load push can
   *  already have gone out, and that reset was lost: the window showed no
   *  session over a running one (UX review 2026-09-22, item 7, found live
   *  2026-09-23). The page asks once subscribed; this answers. */
  function resync(): void {
    const host = deps.host();
    if (host === null) return;
    const active = host.activeSession;
    if (active === null) pointNowhere();
    else pointAt(active);
  }

  /** Follow the host. A session pointed at here plays no opening and
   *  regenerates no orphaned reply: those belong to the activation that was
   *  superseded, and firing them from a reconcile could fire them twice. */
  function reconcile(my: number): void {
    if (my !== activationSeq) return;
    const active = deps.host()?.activeSession ?? null;
    if (active === pointed) return;
    if (active === null) pointNowhere();
    else pointAt(active);
  }

  async function openAndPoint(
    id: string,
  ): Promise<Session | SessionOpenFailure | null> {
    const my = ++activationSeq;
    let s: Session | undefined;
    try {
      s = await deps
        .host()
        ?.openSession({ sessionId: id, lang: await deps.lang() });
    } catch (err) {
      // The host validates the session file BEFORE swapping sessions, so a
      // failed open leaves its open session as it was — but a superseded
      // activation may have made that a different one than the window
      // shows. Report a structured failure instead of letting the
      // renderer's invoke reject with no user-facing surface.
      log(`openSession(${id}) failed:`, err);
      reconcile(my);
      return {
        openError:
          err instanceof SessionFileError
            ? {
                code: err.code,
                ...(err.line !== undefined ? { line: err.line } : {}),
              }
            : { code: "unknown" },
      };
    }
    if (s !== undefined && my === activationSeq) {
      pointAt(s);
      // Restore history only. Regenerating an orphaned reply can re-dispatch
      // already issued tools after a crash. Recovery must be an explicit
      // user action, never a side effect of opening or reloading a session.
    }
    return s ?? null;
  }

  async function createAndPoint(
    opts: CreateSessionOpts,
  ): Promise<Session | null> {
    const my = ++activationSeq;
    let s: Session | undefined;
    try {
      s = await deps.host()?.createSession({
        ...opts,
        // Main-resolved, never renderer-supplied (sanitizeCreateOpts drops
        // any renderer value): the per-user setting is the single source of
        // truth.
        lang: await deps.lang(),
      });
    } catch (err) {
      // A failure before the close leaves the open session as it was; one
      // after it leaves nothing open. Either way the window follows the
      // host, and the caller learns there is no new session (null) instead
      // of an invoke rejected into the void.
      log("createSession failed:", err);
      reconcile(my);
      return null;
    }
    if (s !== undefined && my === activationSeq) {
      pointAt(s);
      // D3: stream the opening seed in like a reply (fire-and-forget; no-op
      // when there is no opening). Fired AFTER pointAt so the renderer is
      // subscribed before the seed streams.
      void s.playOpening?.();
    }
    return s ?? null;
  }

  async function deleteAndReconcile(
    id: string,
  ): Promise<{ readonly ok: boolean; readonly wasActive: boolean }> {
    const host = deps.host();
    if (host === null) return { ok: false, wasActive: false };
    let r: Awaited<ReturnType<SessionHost["deleteSession"]>>;
    try {
      r = await host.deleteSession(id);
    } catch (err) {
      // The host reports a part-way remove itself; a throw is a failure
      // before anything was removed. The session is still on disk,
      // possibly no longer open — the reconcile below decides.
      log(`deleteSession(${id}) failed:`, err);
      r = { ok: false, wasActive: false, removed: false };
    }
    // Gone (the transcript removed, even when its workspace folder could
    // not be): the card drops and, if it was the open session, the window
    // blanks on the event — stop its forwarders so no stale events follow.
    if (r.removed !== false) {
      if (pointed?.sessionId === id) release();
      deps.send(EVT.sessionDeleted, { sessionId: id });
    }
    // Still on disk but closed (the delete failed after the close): the
    // window must not keep showing it as open. The card stays; a click
    // reopens it.
    reconcile(activationSeq);
    return { ok: r.ok, wasActive: r.wasActive };
  }

  return {
    get pointed() {
      return pointed;
    },
    pointAt,
    pointNowhere,
    release,
    resync,
    openAndPoint,
    createAndPoint,
    deleteAndReconcile,
  };
}
