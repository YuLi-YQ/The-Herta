import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectMorph } from "./useConnectMorph.js";
import { useWorkspaceRefs, WorkspaceRefsProvider } from "./WorkspaceRefs.js";

// rAF clock + matchMedia stub — mirrors useRiseAnimation.test's pattern so the
// rise loop is driven deterministically in jsdom (rAF callbacks queue here and
// only fire when `pump()` is called).
let now = 0;
let rafCbs: FrameRequestCallback[] = [];
// The stubbed overlay (= workspace grid column) width. Tests mutate this between
// pumps to simulate the column still reflowing (cards sliding off) so the
// post-rise width-settle watch can be exercised.
let overlayWidth = 800;
// The stubbed workspace-body CONTENT width — the settle watch's live target.
// Tests mutate this mid-watch to simulate a sidebar toggle moving the target
// (no window resize fires for that).
let wbWidth = 800;
function pump(ms: number): void {
  now += ms;
  const cbs = rafCbs;
  rafCbs = [];
  for (const cb of cbs) cb(now);
}

function stubMatchMedia(reduced: boolean): void {
  vi.stubGlobal("matchMedia", () => ({
    matches: reduced,
    addEventListener() {},
    removeEventListener() {},
  }));
}

beforeEach(() => {
  now = 0;
  rafCbs = [];
  overlayWidth = 800;
  wbWidth = 800;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    rafCbs.push(cb);
    return rafCbs.length;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// An external controller flips the hook's inputs without remounting the
// provider (a fresh <WorkspaceRefsProvider> per rerender would churn the
// composer/overlay refs). `setProps` is captured on first render.
let result: ReturnType<typeof useConnectMorph> | null = null;
type HostProps = {
  disconnected: boolean;
  reduced: boolean;
  connected: boolean;
};
let setProps: ((p: HostProps) => void) | null = null;

function HookHost(props: HostProps) {
  const { composerRef, overlayRef } = useWorkspaceRefs();
  const wbRef = { current: null as HTMLDivElement | null };
  const morph = useConnectMorph({
    disconnected: props.disconnected,
    reduced: props.reduced,
    connected: props.connected,
  });
  result = morph;
  // Stub measurable rects on the refs so the FLIP geometry resolves to real
  // numbers (jsdom returns all-zero rects by default). The workspace-body
  // wrapper feeds the settle watch's LIVE target (jsdom paddings parse to 0,
  // so its content width === wbWidth).
  useLayoutEffect(() => {
    if (overlayRef.current) {
      overlayRef.current.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: overlayWidth, height: 600 }) as DOMRect;
      const wb = overlayRef.current.closest(
        ".workspace-body",
      ) as HTMLDivElement | null;
      if (wb) {
        wb.getBoundingClientRect = () =>
          ({ left: 0, top: 0, width: wbWidth, height: 600 }) as DOMRect;
      }
    }
    if (composerRef.current) {
      composerRef.current.getBoundingClientRect = () =>
        ({ left: 40, top: 520, width: 600, height: 78 }) as DOMRect;
    }
  });
  return (
    <div className="workspace-body" ref={wbRef}>
      <form ref={composerRef} className="composer" />
      <div ref={overlayRef} className="morph-overlay" />
      {morph.morphing && (
        <div ref={morph.cloneRef} className="connect-morph-clone" />
      )}
    </div>
  );
}

function Controller(init: HostProps) {
  const [props, set] = useState(init);
  setProps = set;
  return (
    <HookHost
      disconnected={props.disconnected}
      reduced={props.reduced}
      connected={props.connected}
    />
  );
}

function renderHost(
  disconnected: boolean,
  reduced: boolean,
  connected: boolean,
) {
  stubMatchMedia(reduced);
  result = null;
  setProps = null;
  return render(
    <WorkspaceRefsProvider>
      <Controller
        disconnected={disconnected}
        reduced={reduced}
        connected={connected}
      />
    </WorkspaceRefsProvider>,
  );
}

function update(p: HostProps): void {
  act(() => {
    setProps?.(p);
  });
}

describe("useConnectMorph", () => {
  it("is not morphing initially (already disconnected, no rising edge)", () => {
    renderHost(true, false, false);
    expect(result?.morphing).toBe(false);
  });

  it("is not morphing when connected", () => {
    renderHost(false, false, true);
    expect(result?.morphing).toBe(false);
  });

  it("flips morphing true on the connected→disconnected edge (reduced:false)", () => {
    renderHost(false, false, true);
    expect(result?.morphing).toBe(false);
    update({ disconnected: true, reduced: false, connected: false });
    expect(result?.morphing).toBe(true);
  });

  it("does NOT morph on the launch edge (never connected → disconnected)", () => {
    // Bootstrapping (disconnected:false, connected:false) → noSession
    // (disconnected:true, connected:false). No prior session ⇒ this is the
    // initial connect screen, not a transition, so it must stay static.
    renderHost(false, false, false);
    expect(result?.morphing).toBe(false);
    update({ disconnected: true, reduced: false, connected: false });
    expect(result?.morphing).toBe(false);
  });

  it("never morphs under reduced motion on the edge", () => {
    renderHost(false, true, true);
    expect(result?.morphing).toBe(false);
    update({ disconnected: true, reduced: true, connected: false });
    expect(result?.morphing).toBe(false);
  });

  it("returns morphing to false after the rise AND the column reaches full width", () => {
    renderHost(false, false, true);
    update({ disconnected: true, reduced: false, connected: false }); // captures finalWorkspaceWidth = 800
    expect(result?.morphing).toBe(true);
    // The clone mounted (morphing=true) and the animate layout effect queued the
    // rise. Drive the rAF clock past MORPH_MS (800): onSettle now starts the
    // column-settle watch — it does NOT clear morphing yet.
    act(() => pump(0));
    act(() => pump(900));
    expect(result?.morphing).toBe(true);
    // The stubbed column is already at its final width (800), so the next watch
    // frame hands off to the static button.
    act(() => pump(16));
    expect(result?.morphing).toBe(false);
  });

  it("holds the clone (does not hand off) until the column reaches its final width", () => {
    // Regression: the static ConnectStation centres in the workspace grid
    // column. If the clone handed off while that column was still widening (the
    // cards sliding off), the CSS-centred button would jump left then drift
    // right — a horizontal jitter. The watch must keep morphing until the column
    // reaches its FINAL width — NOT merely until the per-frame delta goes small,
    // which the cards' ease-out tail (sub-pixel-per-frame yet still far short)
    // would trigger far too early.
    renderHost(false, false, true);
    update({ disconnected: true, reduced: false, connected: false }); // captures finalWorkspaceWidth = 800
    // Simulate the column still mid-reflow, narrower than its 800 target.
    overlayWidth = 700;
    act(() => pump(0));
    act(() => pump(900)); // rise settles → column-settle watch begins
    // While the column is below its final width, never hand off — even across
    // many frames where the ease-out tail would creep sub-pixel.
    for (const w of [720, 770, 797]) {
      overlayWidth = w;
      act(() => pump(16));
      expect(result?.morphing).toBe(true);
    }
    // Column reaches its final width → hand off to the static button.
    overlayWidth = 800;
    act(() => pump(16));
    expect(result?.morphing).toBe(false);
  });

  it("tracks a sidebar toggle mid-watch: waits for the MOVED target, glides the clone to the new centre, then hands off (2026-07-14)", () => {
    renderHost(false, false, true);
    update({ disconnected: true, reduced: false, connected: false }); // target 800 at flight start
    overlayWidth = 700; // column still mid-reflow
    act(() => pump(0));
    act(() => pump(900)); // rise settles → settle watch begins (clone landed at (800-240)/2 = 280)
    // Sidebar collapses mid-watch: the workspace-body content width jumps to
    // 1030 — the ONCE-measured 800 target is stale. The watch must now wait
    // for the live 1030, not complete at 800.
    wbWidth = 1030;
    for (const w of [770, 800, 900, 1020]) {
      overlayWidth = w;
      act(() => pump(16));
      expect(result?.morphing).toBe(true);
    }
    // Column reaches the LIVE target → the clone glides to the new centre
    // ((1030-240)/2 = 395) and hands off only after the glide.
    overlayWidth = 1030;
    act(() => pump(16));
    expect(result?.morphing).toBe(true); // gliding
    const clone = document.querySelector(".connect-morph-clone") as HTMLElement;
    expect(clone.style.left).toBe("395px");
    act(() => pump(200)); // glide wait (rAF clock) elapses
    expect(result?.morphing).toBe(false);
  });

  it("clears morphing when disconnected goes false (reconnect — no morph)", () => {
    renderHost(false, false, true);
    update({ disconnected: true, reduced: false, connected: false });
    expect(result?.morphing).toBe(true);
    update({ disconnected: false, reduced: false, connected: true });
    expect(result?.morphing).toBe(false);
    // Pump past the morph duration (800) to confirm a cancelled rise does not
    // fire a late onSettle that re-toggles morphing back to true.
    act(() => pump(900));
    expect(result?.morphing).toBe(false);
  });
});
