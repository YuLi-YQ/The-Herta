import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReconnectMorph } from "./useReconnectMorph.js";
import { useWorkspaceRefs, WorkspaceRefsProvider } from "./WorkspaceRefs.js";

// rAF clock — mirrors useConnectMorph.test's pattern: callbacks queue here and
// only fire when `pump()` is called, so the hand-off's arrival watch is driven
// deterministically in jsdom.
let rafCbs: FrameRequestCallback[] = [];
let now = 0;
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

// The live rects the arrival watch polls. In the real DOM the anchor frame
// rides layout changes automatically (right/bottom insets); jsdom has no
// layout, so tests steer both rects directly to simulate the scenarios.
let sendRect = {
  left: 720,
  top: 520,
  right: 758,
  bottom: 558,
  width: 38,
  height: 38,
};
let anchorRect = {
  left: 720,
  top: 520,
  right: 758,
  bottom: 558,
  width: 38,
  height: 38,
};

let result: ReturnType<typeof useReconnectMorph> | null = null;
let setDisc: ((v: boolean) => void) | null = null;

function Host(props: { reduced: boolean }) {
  const { overlayRef, sendButtonRef } = useWorkspaceRefs();
  const [disconnected, setDisconnected] = useState(true);
  setDisc = setDisconnected;
  const morph = useReconnectMorph({ disconnected, reduced: props.reduced });
  result = morph;
  // Install the rect mocks BEFORE the test's begin() call (mount layout
  // effect), so begin() computes the anchor insets from these.
  useLayoutEffect(() => {
    if (overlayRef.current) {
      overlayRef.current.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          right: 800,
          bottom: 600,
          width: 800,
          height: 600,
        }) as DOMRect;
    }
    if (sendButtonRef.current) {
      sendButtonRef.current.getBoundingClientRect = () => sendRect as DOMRect;
    }
    if (morph.anchorRef.current) {
      morph.anchorRef.current.getBoundingClientRect = () =>
        anchorRect as DOMRect;
    }
  });
  return (
    <>
      <div ref={overlayRef} className="morph-overlay" />
      <button ref={sendButtonRef} type="button">
        s
      </button>
      {morph.reconnecting && (
        <div ref={morph.anchorRef} className="reconnect-morph-anchor">
          <div ref={morph.cloneRef} className="reconnect-morph-clone" />
        </div>
      )}
    </>
  );
}

function renderHost(reduced: boolean) {
  stubMatchMedia(reduced);
  result = null;
  setDisc = null;
  return render(
    <WorkspaceRefsProvider>
      <Host reduced={reduced} />
    </WorkspaceRefsProvider>,
  );
}

const RECT = { left: 280, top: 270, width: 240, height: 56 } as DOMRect;

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  rafCbs = [];
  sendRect = {
    left: 720,
    top: 520,
    right: 758,
    bottom: 558,
    width: 38,
    height: 38,
  };
  anchorRect = {
    left: 720,
    top: 520,
    right: 758,
    bottom: 558,
    width: 38,
    height: 38,
  };
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    rafCbs.push(cb);
    return rafCbs.length;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useReconnectMorph", () => {
  it("is not reconnecting initially", () => {
    renderHost(false);
    expect(result?.reconnecting).toBe(false);
  });

  it("begin() starts the morph and pins the anchor at the final send spot (overlay-relative left/top)", () => {
    renderHost(false);
    act(() => result?.begin(RECT));
    expect(result?.reconnecting).toBe(true);
    const anchor = document.querySelector(
      ".reconnect-morph-anchor",
    ) as HTMLElement;
    // send.left 720 − overlay.left 0 = 720; send.top 520 − overlay.top 0 = 520.
    // (jsdom normalizes "720.00px" to "720px".)
    expect(anchor.style.left).toBe("720px");
    expect(anchor.style.top).toBe("520px");
    expect(anchor.style.width).toBe("38px");
  });

  it("never morphs under reduced motion", () => {
    renderHost(true);
    act(() => result?.begin(RECT));
    expect(result?.reconnecting).toBe(false);
  });

  it("retargets the anchor to the live send spot on a mid-morph window resize (2026-07-15)", () => {
    // Toggling maximize/restore during the morph moves where the send button
    // settles — a change begin() could not predict. A window `resize` re-measures
    // and re-places the anchor (rAF-coalesced) so the clone lands on the new
    // spot instead of the pre-resize pixel.
    renderHost(false);
    act(() => result?.begin(RECT));
    const anchor = document.querySelector(
      ".reconnect-morph-anchor",
    ) as HTMLElement;
    expect(anchor.style.left).toBe("720px"); // initial: sendRect.left 720 − overlay 0
    // The window resized; the send button now settles further right.
    sendRect = { ...sendRect, left: 1100, right: 1138 };
    act(() => {
      window.dispatchEvent(new Event("resize"));
      pump(16); // retarget is rAF-throttled
    });
    expect(anchor.style.left).toBe("1100px");
    // Re-placed with a slide transition, not a teleport.
    expect(anchor.style.transition).toContain("left");
  });

  it("hands off once landed, connected, and the real button has arrived in the frame", () => {
    renderHost(false);
    act(() => result?.begin(RECT));
    expect(result?.reconnecting).toBe(true);
    // 2100ms covers the longest distance-scaled flight (600 + ≤1400ms).
    act(() => vi.advanceTimersByTime(2100));
    expect(result?.reconnecting).toBe(true);
    act(() => setDisc?.(false));
    // The arrival watch needs one frame to see the (already-arrived) button.
    expect(result?.revealing).toBe(false);
    act(() => pump(16));
    expect(result?.revealing).toBe(true);
    expect(result?.reconnecting).toBe(true);
    // Phase 2: after the cross-fade (REVEAL_MS), the clone unmounts.
    act(() => vi.advanceTimersByTime(260));
    expect(result?.reconnecting).toBe(false);
    expect(result?.revealing).toBe(false);
  });

  it("does not counter-translate the clone — the frame is fixed at the final spot, so there is no ride to blend (2026-07-15)", () => {
    renderHost(false);
    act(() => result?.begin(RECT));
    act(() => pump(16));
    const clone = document.querySelector(
      ".reconnect-morph-clone",
    ) as HTMLElement;
    // Even if the overlay narrows mid-flight, the anchor is left/top-pinned at
    // the FINAL send spot and never rides, so the clone carries no blend
    // translate (the flight arcs straight to the fixed target).
    anchorRect = { ...anchorRect, left: -362, right: -324 };
    act(() => pump(16));
    expect(clone.style.translate).toBe("");
  });

  it("holds when landed but still disconnected (slow load)", () => {
    renderHost(false);
    act(() => result?.begin(RECT));
    act(() => vi.advanceTimersByTime(2100)); // past any distance-scaled flight
    expect(result?.reconnecting).toBe(true);
  });

  it("holds the reveal until the footer's entrance carries the button into the frame", () => {
    renderHost(false);
    act(() => result?.begin(RECT));
    act(() => vi.advanceTimersByTime(2100)); // landed, still disconnected
    // The session opens now; the footer is still sliding up from below —
    // the live button sits under the frame for a while.
    sendRect = { ...sendRect, top: 650, bottom: 688 };
    act(() => setDisc?.(false));
    for (let i = 0; i < 5; i++) {
      act(() => pump(16));
      expect(result?.revealing).toBe(false); // watch holds — button below
    }
    // Footer arrives: the live button matches the frame.
    sendRect = { ...sendRect, top: 520, bottom: 558 };
    act(() => pump(16));
    expect(result?.revealing).toBe(true);
  });

  it("guard: snaps the anchor to the live button before revealing when arrival never happens", () => {
    renderHost(false);
    act(() => result?.begin(RECT));
    act(() => vi.advanceTimersByTime(2100));
    // A garbage begin()-measurement: the live button settled somewhere the
    // frame is not, and never converges.
    sendRect = {
      left: 1082,
      top: 560,
      right: 1120,
      bottom: 598,
      width: 38,
      height: 38,
    };
    act(() => setDisc?.(false));
    for (let i = 0; i < 240; i++) act(() => pump(16));
    expect(result?.revealing).toBe(false);
    act(() => pump(16)); // frame 241 exceeds the guard
    expect(result?.revealing).toBe(true);
    const anchor = document.querySelector(
      ".reconnect-morph-anchor",
    ) as HTMLElement;
    // Self-heal: the frame snapped to the live button (left 1082−0, top 560−0).
    expect(anchor.style.left).toBe("1082px");
    expect(anchor.style.top).toBe("560px");
  });

  it("pulses the landed clone through the holds, and stops the moment the reveal starts", () => {
    renderHost(false);
    act(() => result?.begin(RECT));
    const clone = document.querySelector(".reconnect-morph-clone");
    expect(clone?.classList.contains("is-waiting")).toBe(false); // in flight
    act(() => vi.advanceTimersByTime(2100)); // landed, still disconnected
    expect(clone?.classList.contains("is-waiting")).toBe(true);
    act(() => setDisc?.(false)); // session loaded → arrival watch begins
    expect(clone?.classList.contains("is-waiting")).toBe(true);
    act(() => pump(16)); // arrived → reveal begins
    // The pulse must be gone the moment the reveal starts — its infinite
    // opacity animation would override the cross-fade transition.
    expect(clone?.classList.contains("is-waiting")).toBe(false);
    expect(result?.revealing).toBe(true);
  });

  it("cancel() clears the morph", () => {
    renderHost(false);
    act(() => result?.begin(RECT));
    act(() => result?.cancel());
    expect(result?.reconnecting).toBe(false);
  });

  it("begin() is a no-op when the refs are not attached", () => {
    stubMatchMedia(false);
    function Bare() {
      result = useReconnectMorph({ disconnected: true, reduced: false });
      return null;
    }
    render(
      <WorkspaceRefsProvider>
        <Bare />
      </WorkspaceRefsProvider>,
    );
    act(() => result?.begin(RECT));
    expect(result?.reconnecting).toBe(false);
  });
});
