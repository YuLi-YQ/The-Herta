import { describe, expect, it } from "vitest";
import {
  OVERLAY_Z,
  popOverlay,
  pushOverlay,
  topOverlay,
} from "./overlay-stack.js";

describe("overlay-stack", () => {
  it("topmost is decided by z-level (CSS mirror), not registration order", () => {
    // Settings opens FIRST; a permission gate arrives SECOND. The approval
    // panel sits visually UNDER the settings backdrop (z 40 < 60), so it must
    // not become top just because it registered later.
    pushOverlay("settings", OVERLAY_Z.settings);
    pushOverlay("approval", OVERLAY_Z.approval);
    expect(topOverlay()).toBe("settings");
    popOverlay("settings");
    expect(topOverlay()).toBe("approval");
    popOverlay("approval");
    expect(topOverlay()).toBeNull();
  });

  it("ties at the same z-level break to the most recently opened", () => {
    pushOverlay("settings", OVERLAY_Z.settings);
    pushOverlay("key-prompt", OVERLAY_Z.keyPrompt); // same 60 band, newer
    expect(topOverlay()).toBe("key-prompt");
    popOverlay("key-prompt");
    expect(topOverlay()).toBe("settings");
    popOverlay("settings");
  });

  it("a menu floats above everything", () => {
    pushOverlay("approval", OVERLAY_Z.approval);
    pushOverlay("settings", OVERLAY_Z.settings);
    pushOverlay("card-menu", OVERLAY_Z.cardMenu);
    expect(topOverlay()).toBe("card-menu");
    popOverlay("card-menu");
    popOverlay("settings");
    popOverlay("approval");
  });

  it("pop removes the newest entry for a duplicated id", () => {
    pushOverlay("card-menu", OVERLAY_Z.cardMenu);
    pushOverlay("card-menu", OVERLAY_Z.cardMenu);
    popOverlay("card-menu");
    expect(topOverlay()).toBe("card-menu");
    popOverlay("card-menu");
    expect(topOverlay()).toBeNull();
  });
});
