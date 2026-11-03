import { afterEach, expect, it, vi } from "vitest";
import { appearance, initializeAppearance } from "./appearance.js";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.appearance;
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.motion;
});

it.each([null, "classic", "observatory", "unknown"])(
  "uses the unified UI when an older preference is %s",
  (stored) => {
    if (stored !== null) localStorage.setItem("the-herta.appearance.v1", stored);
    localStorage.setItem("the-herta.motion.v1", "off");
    localStorage.setItem("herta-theme-resolved", "light");
    localStorage.setItem("the-herta.font.test", "existing-font-choice");
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.motion = "off";
    const set = vi.spyOn(Storage.prototype, "setItem");
    initializeAppearance();
    expect(appearance()).toBe("observatory");
    expect(document.documentElement.dataset.appearance).toBe("observatory");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.motion).toBe("off");
    expect(localStorage.getItem("the-herta.motion.v1")).toBe("off");
    expect(localStorage.getItem("herta-theme-resolved")).toBe("light");
    expect(localStorage.getItem("the-herta.font.test")).toBe("existing-font-choice");
    expect(set).not.toHaveBeenCalled();
  },
);

it("still starts the unified UI when browser preference storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  expect(() => initializeAppearance()).not.toThrow();
  expect(document.documentElement.dataset.appearance).toBe("observatory");
});
