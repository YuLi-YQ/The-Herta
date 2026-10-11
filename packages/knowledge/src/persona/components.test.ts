import { describe, expect, it } from "vitest";
import {
  getPersonaComponent,
  PERSONA_COMPONENT_IDS,
  PERSONA_COMPONENTS,
} from "./components.js";

describe("PERSONA_COMPONENTS registry", () => {
  it("declares the 4 starter components", () => {
    expect(PERSONA_COMPONENT_IDS).toEqual(
      expect.arrayContaining(["wardrobe", "workshop", "doll-fleet", "today"]),
    );
    expect(PERSONA_COMPONENTS.length).toBe(4);
  });

  it("each component has a unique id", () => {
    const ids = PERSONA_COMPONENTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("getPersonaComponent returns the matching spec", () => {
    expect(getPersonaComponent("wardrobe")?.id).toBe("wardrobe");
    expect(getPersonaComponent("today")?.persistence).toBe("per_session");
    expect(getPersonaComponent("wardrobe")?.persistence).toBe("persistent");
  });

  it("returns undefined for unknown component id", () => {
    expect(getPersonaComponent("not_a_component")).toBeUndefined();
  });

  it("each component validate() round-trips", () => {
    const wardrobe = getPersonaComponent("wardrobe");
    if (!wardrobe) throw new Error("wardrobe missing from registry");
    const v = wardrobe.validate({
      outfits: [
        {
          id: "default",
          name: "x",
          description: "y",
          canonGrounded: true,
        },
      ],
      currentlyWorn: "default",
      lastChangedAt: "2026-05-09T00:00:00Z",
    });
    expect(v.ok).toBe(true);
  });

  it("each component seedPrompt is a non-empty function", () => {
    for (const c of PERSONA_COMPONENTS) {
      const out = c.seedPrompt("sample canon context");
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(50);
    }
  });
});
