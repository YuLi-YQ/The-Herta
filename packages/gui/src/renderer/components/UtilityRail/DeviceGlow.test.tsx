import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceGlow } from "./DeviceGlow.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Recording WebGL stub + fake-clock rAF (the AuraVisual.test.tsx pattern —
 *  jsdom has no WebGL; query methods return truthy stand-ins so setup
 *  "succeeds" and everything else counts calls). */
function mockWebgl(): { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const gl = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "getShaderParameter" || prop === "getProgramParameter")
          return () => true;
        if (
          prop === "createShader" ||
          prop === "createProgram" ||
          prop === "createBuffer" ||
          prop === "createTexture"
        )
          return () => ({});
        if (prop === "getUniformLocation") return () => ({});
        if (prop === "getAttribLocation") return () => 0;
        if (prop === "getShaderInfoLog" || prop === "getProgramInfoLog")
          return () => "";
        if (prop === "canvas") return undefined;
        return (..._args: unknown[]) => {
          calls[prop] = (calls[prop] ?? 0) + 1;
          return undefined;
        };
      },
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
    type: string,
  ) =>
    type === "webgl"
      ? gl
      : null) as typeof HTMLCanvasElement.prototype.getContext);
  return { calls };
}

function mockAsyncRaf(): void {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    return setTimeout(() => {
      now += 16;
      cb(now);
    }, 16) as unknown as number;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  });
}

describe("DeviceGlow", () => {
  it("parks once calm with the window unfocused; a focus or a state change wakes it (perf 2026-09-03)", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { calls } = mockWebgl();
    const { rerender } = render(<DeviceGlow state="idle" />);
    act(() => {
      window.dispatchEvent(new Event("blur"));
      // Past CALM_HOLD_MS + PARK_UNFOCUSED_MS of drawn-frame time (the mock
      // clock advances only on drawn frames; the governor sleeps between).
      vi.advanceTimersByTime(20_000);
    });
    const parkedAt = calls.drawArrays ?? 0;
    expect(parkedAt).toBeGreaterThan(50);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect((calls.drawArrays ?? 0) - parkedAt).toBe(0);
    // A state change wakes a parked loop even while unfocused…
    rerender(<DeviceGlow state="delegated" />);
    act(() => {
      vi.advanceTimersByTime(16 * 5);
    });
    const afterState = calls.drawArrays ?? 0;
    expect(afterState).toBeGreaterThan(parkedAt + 1);
    // …and so does focus, once it has parked again.
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    const parkedAgain = calls.drawArrays ?? 0;
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect((calls.drawArrays ?? 0) - parkedAgain).toBe(0);
    act(() => {
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(16 * 5);
    });
    expect(calls.drawArrays ?? 0).toBeGreaterThan(parkedAgain + 1);
  });

  it("renders the canvas layer plus the legacy stack as fallback markup", () => {
    const { container } = render(<DeviceGlow state="delegated" />);
    expect(container.querySelector("canvas.device-glow-canvas")).toBeTruthy();
    // jsdom has no WebGL → getContext returns null → the canvas flags the
    // fallback and the legacy spill/ring stack (with state classes) carries
    // the visual. This is the same DOM contract DeviceCard's tests pin.
    const canvas = container.querySelector(
      "canvas.device-glow-canvas",
    ) as HTMLCanvasElement;
    expect(canvas.dataset.fallback).toBe("true");
    expect(container.querySelector(".agent-spill.is-delegated")).toBeTruthy();
    expect(container.querySelector(".agent-ring.is-delegated")).toBeTruthy();
  });

  it("stops + reveals the legacy stack on context loss, rebuilds on restore (audit 2026-07-13 T2.1)", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { calls } = mockWebgl();
    const { container } = render(<DeviceGlow state="delegated" />);
    const canvas = container.querySelector(
      "canvas.device-glow-canvas",
    ) as HTMLCanvasElement;
    act(() => {
      vi.advanceTimersByTime(16 * 3);
    });
    expect(canvas.dataset.fallback).toBeUndefined();
    const lost = new Event("webglcontextlost", { cancelable: true });
    act(() => {
      canvas.dispatchEvent(lost);
    });
    expect(lost.defaultPrevented).toBe(true);
    expect(canvas.dataset.fallback).toBe("true");
    const during = calls.drawArrays ?? 0;
    act(() => {
      vi.advanceTimersByTime(16 * 5);
    });
    expect((calls.drawArrays ?? 0) - during).toBe(0);
    const linked = calls.linkProgram ?? 0;
    act(() => {
      canvas.dispatchEvent(new Event("webglcontextrestored"));
      vi.advanceTimersByTime(16 * 5);
    });
    expect(calls.linkProgram ?? 0).toBe(linked + 1);
    expect(canvas.dataset.fallback).toBeUndefined();
    expect(calls.drawArrays ?? 0).toBeGreaterThan(during + 2);
  });

  it("uploads a theme's lamp layer once its image has decoded, and draws it (ADR 0057 §2.14)", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { calls } = mockWebgl();
    // A recording Image: the component asks for two (light, dark) and
    // uploads each when it loads; jsdom never loads one by itself.
    const made: Array<{ onload: (() => void) | null; src: string }> = [];
    class FakeImage {
      onload: (() => void) | null = null;
      decoding = "async";
      src = "";
      complete = false;
      naturalWidth = 0;
      constructor() {
        made.push(this);
      }
    }
    vi.stubGlobal("Image", FakeImage);
    render(<DeviceGlow state="idle" />);
    expect(made.length).toBe(2);
    expect(made.map((m) => m.src).every((s) => s.length > 0)).toBe(true);
    act(() => {
      vi.advanceTimersByTime(16 * 3);
    });
    expect(calls.texImage2D ?? 0).toBe(0);
    const first = made[0] as FakeImage;
    first.complete = true;
    first.naturalWidth = 896;
    act(() => {
      first.onload?.();
      vi.advanceTimersByTime(16 * 3);
    });
    expect(calls.texImage2D).toBe(1);
    expect(calls.bindTexture ?? 0).toBeGreaterThan(1);
    vi.unstubAllGlobals();
  });

  it("an image already complete when its src is set (the browser's cache, StrictMode's second mount) uploads during setup without throwing (owner 2026-09-07: the Settings pane crashed)", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { calls } = mockWebgl();
    // Chromium fires a cached image's load event synchronously from the
    // src setter — the shape that crashed: the handler runs before the
    // effect has declared its loop.
    class CachedImage {
      onload: (() => void) | null = null;
      decoding = "async";
      complete = true;
      naturalWidth = 560;
      #src = "";
      get src(): string {
        return this.#src;
      }
      set src(value: string) {
        this.#src = value;
        this.onload?.();
      }
    }
    vi.stubGlobal("Image", CachedImage);
    expect(() => render(<DeviceGlow state="idle" />)).not.toThrow();
    // Both themes' layers went up once each — the synchronous load
    // uploaded them and the build's own pass found them present.
    expect(calls.texImage2D).toBe(2);
    // …and the loop draws with them.
    act(() => {
      vi.advanceTimersByTime(16 * 3);
    });
    expect(calls.drawArrays ?? 0).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it("fallback state classes track the state prop", () => {
    const { container, rerender } = render(<DeviceGlow state="idle" />);
    expect(container.querySelector(".agent-ring.is-idle")).toBeTruthy();
    rerender(<DeviceGlow state="waitingApproval" />);
    expect(
      container.querySelector(".agent-ring.is-waitingApproval"),
    ).toBeTruthy();
    expect(container.querySelector(".agent-ring.is-idle")).toBeNull();
  });
});
