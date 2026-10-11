import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { renderWithSession } from "../../testing/renderWithSession.js";
import { AuraVisual } from "./AuraVisual.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Recording WebGL-context stub — jsdom has no real WebGL. Query methods return
 *  truthy stand-ins so program/shader setup "succeeds"; everything else is a
 *  call-counting no-op (so we can assert drawArrays per frame). */
function mockWebgl(renderer?: string): { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const gl = new Proxy(
    {},
    {
      get(_t, prop: string) {
        // The renderer string, when a test names one (a software rasterizer).
        if (renderer !== undefined && prop === "getExtension")
          return (name: string) =>
            name === "WEBGL_debug_renderer_info"
              ? { UNMASKED_RENDERER_WEBGL: 0x9246 }
              : null;
        if (renderer !== undefined && prop === "getParameter")
          return () => renderer;
        if (prop === "getShaderParameter" || prop === "getProgramParameter")
          return () => true;
        if (
          prop === "createShader" ||
          prop === "createProgram" ||
          prop === "createBuffer"
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

/** rAF driven by a fake clock (the canvas-loop test pattern). */
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

function renderAura() {
  const mock = createMockHertaBridge();
  return render(
    <HertaBridgeProvider bridge={mock.bridge}>
      <AuraVisual />
    </HertaBridgeProvider>,
  );
}

describe("AuraVisual", () => {
  it("renders the canvas + fallback element", () => {
    const { container } = renderAura();
    expect(container.querySelector("canvas.aura-canvas")).not.toBeNull();
    expect(container.querySelector(".aura-fallback")).not.toBeNull();
  });

  it("flags the fallback when WebGL is unavailable (jsdom)", () => {
    const { container } = renderAura();
    const canvas = container.querySelector(
      "canvas.aura-canvas",
    ) as HTMLCanvasElement;
    // jsdom's getContext returns null for "webgl" → component sets data-fallback.
    expect(canvas.dataset.fallback).toBe("true");
  });

  it("does not throw when matchMedia / reduced motion is set", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (q: string) =>
        ({
          matches: q.includes("prefers-reduced-motion"),
          media: q,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
    expect(() => renderAura()).not.toThrow();
  });

  it("runs the rAF draw loop and stops on unmount", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { calls } = mockWebgl();
    const { unmount } = renderAura();
    act(() => {
      vi.advanceTimersByTime(16 * 5);
    });
    const drawn = calls.drawArrays ?? 0;
    expect(drawn).toBeGreaterThanOrEqual(3);
    unmount();
    act(() => {
      vi.advanceTimersByTime(16 * 5);
    });
    expect((calls.drawArrays ?? 0) - drawn).toBeLessThanOrEqual(1);
  });

  it("a CPU rasterizer gets the static CSS aura, not a display-rate shader (platform review 2026-09-23)", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { calls } = mockWebgl(
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))",
    );
    const { container } = renderAura();
    act(() => {
      vi.advanceTimersByTime(16 * 5);
    });
    const canvas = container.querySelector(
      "canvas.aura-canvas",
    ) as HTMLCanvasElement;
    expect(canvas.dataset.fallback).toBe("true");
    expect(calls.drawArrays ?? 0).toBe(0);
  });

  it("stops + reveals the fallback on context loss, rebuilds + resumes on restore (audit 2026-07-13 T2.1)", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { calls } = mockWebgl();
    const { container } = renderAura();
    const canvas = container.querySelector(
      "canvas.aura-canvas",
    ) as HTMLCanvasElement;
    act(() => {
      vi.advanceTimersByTime(16 * 3);
    });
    expect(canvas.dataset.fallback).toBeUndefined();
    // GPU reset (TDR / driver update / sleep-wake): the loop must stop and
    // the CSS fallback must show instead of a dead transparent canvas.
    const lost = new Event("webglcontextlost", { cancelable: true });
    act(() => {
      canvas.dispatchEvent(lost);
    });
    // preventDefault is the restoration opt-in — without it the browser
    // never fires webglcontextrestored.
    expect(lost.defaultPrevented).toBe(true);
    expect(canvas.dataset.fallback).toBe("true");
    const during = calls.drawArrays ?? 0;
    act(() => {
      vi.advanceTimersByTime(16 * 5);
    });
    expect((calls.drawArrays ?? 0) - during).toBe(0);
    // Restore: program/buffer rebuild (a second link), fallback hides,
    // drawing resumes.
    const linked = calls.linkProgram ?? 0;
    act(() => {
      canvas.dispatchEvent(new Event("webglcontextrestored"));
      vi.advanceTimersByTime(16 * 5);
    });
    expect(calls.linkProgram ?? 0).toBe(linked + 1);
    expect(canvas.dataset.fallback).toBeUndefined();
    expect(calls.drawArrays ?? 0).toBeGreaterThan(during + 2);
  });

  it("parks once calm with the window unfocused, and a focus wakes it (perf 2026-09-03)", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { calls } = mockWebgl();
    // A live session so the aura is LISTENING (calm is judged on that
    // state); the mock clock only advances on drawn frames.
    const mock = createMockHertaBridge();
    const h = renderWithSession(<AuraVisual />, { mock });
    h.openSession("s1");
    act(() => {
      window.dispatchEvent(new Event("blur"));
      // Well past CALM_HOLD_MS + PARK_UNFOCUSED_MS of drawn-frame time (the
      // governor sleeps ~14ms of every 30ms, so wall time runs ~2× ahead).
      vi.advanceTimersByTime(20_000);
    });
    const parkedAt = calls.drawArrays ?? 0;
    expect(parkedAt).toBeGreaterThan(50);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    // Parked: nothing drawn while unfocused and calm.
    expect((calls.drawArrays ?? 0) - parkedAt).toBe(0);
    act(() => {
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(16 * 5);
    });
    expect(calls.drawArrays ?? 0).toBeGreaterThan(parkedAt + 1);
  });

  it("pauses while document.hidden and resumes on visibilitychange", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { calls } = mockWebgl();
    renderAura();
    act(() => {
      vi.advanceTimersByTime(16 * 3);
    });
    const before = calls.drawArrays ?? 0;
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(16 * 5);
    });
    expect((calls.drawArrays ?? 0) - before).toBeLessThanOrEqual(1);
    Object.defineProperty(document, "hidden", {
      value: false,
      configurable: true,
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(16 * 5);
    });
    expect(calls.drawArrays ?? 0).toBeGreaterThan(before + 2);
  });
});
