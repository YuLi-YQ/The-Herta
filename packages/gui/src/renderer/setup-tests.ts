import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

// jsdom does not implement matchMedia. Provide a minimal stub so any component
// that calls useReducedMotion (which reads window.matchMedia) does not throw.
// jsdom also does not implement scrollIntoView. Stub it globally so components
// that call endRef.current?.scrollIntoView(...) do not throw.
if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = () =>
      ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => undefined;
  }
  // jsdom does not implement ResizeObserver. Minimal stub so hooks that
  // observe content growth (useScrollEdges) construct without throwing.
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
}

beforeEach(() => {
  // matchMedia stub is now set up at module load above; nothing extra needed.
});

// Ensure React Testing Library cleanup runs after every test even when
// vitest is configured with globals: false (RTL auto-cleanup relies on
// the global afterEach which is not injected in non-globals mode).
afterEach(() => {
  cleanup();
});
