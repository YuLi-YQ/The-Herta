import { describe, expect, it } from "vitest";
import { validateDollFleetState } from "./doll-fleet.js";
import { validateTodayState } from "./today.js";
import { validateWardrobeState } from "./wardrobe.js";
import { validateWorkshopState } from "./workshop.js";

describe("validateWardrobeState", () => {
  it("accepts a valid state", () => {
    const v = validateWardrobeState({
      outfits: [
        {
          id: "default",
          name: "默认",
          description: "...",
          canonGrounded: true,
        },
      ],
      currentlyWorn: "default",
      lastChangedAt: "2026-05-09T00:00:00Z",
    });
    expect(v.ok).toBe(true);
  });

  it("rejects when currentlyWorn doesn't match any outfit id", () => {
    const v = validateWardrobeState({
      outfits: [{ id: "a", name: "x", description: "y", canonGrounded: false }],
      currentlyWorn: "doesnt_exist",
      lastChangedAt: "2026-05-09T00:00:00Z",
    });
    expect(v.ok).toBe(false);
    expect(v.errors?.join(" ")).toMatch(/currentlyWorn/);
  });

  it("rejects malformed shape", () => {
    expect(validateWardrobeState({}).ok).toBe(false);
    expect(validateWardrobeState({ outfits: "not an array" }).ok).toBe(false);
  });
});

describe("validateWorkshopState", () => {
  it("accepts a valid state", () => {
    expect(
      validateWorkshopState({
        desk: [{ id: "x", label: "y", description: "z", state: "in_progress" }],
        shelves: [],
        recentActivity: ["did a thing"],
      }).ok,
    ).toBe(true);
  });
  it("rejects unknown desk-item state", () => {
    expect(
      validateWorkshopState({
        desk: [{ id: "x", label: "y", description: "z", state: "exploded" }],
        shelves: [],
        recentActivity: [],
      }).ok,
    ).toBe(false);
  });
});

describe("validateDollFleetState", () => {
  it("accepts a valid state with multiple dolls", () => {
    expect(
      validateDollFleetState({
        dolls: [
          {
            id: "doll-1",
            deployedTo: "Penacony",
            status: "active",
            lastReportedAt: "2026-05-09T00:00:00Z",
          },
          {
            id: "doll-2",
            deployedTo: "in pieces in the workshop",
            status: "in_pieces",
            lastReportedAt: "2026-05-08T00:00:00Z",
          },
        ],
      }).ok,
    ).toBe(true);
  });
  it("rejects duplicate doll ids", () => {
    expect(
      validateDollFleetState({
        dolls: [
          { id: "x", deployedTo: "a", status: "active", lastReportedAt: "t" },
          { id: "x", deployedTo: "b", status: "active", lastReportedAt: "t" },
        ],
      }).ok,
    ).toBe(false);
  });
});

describe("validateTodayState", () => {
  it("accepts a valid state", () => {
    expect(
      validateTodayState({
        mood: "bored",
        annoyance: "Stephen forgot the observers again",
        preoccupation: "Simulated Universe v0.3 balance",
        generatedAt: "2026-05-09T00:00:00Z",
      }).ok,
    ).toBe(true);
  });
  it("rejects unknown mood", () => {
    expect(
      validateTodayState({
        mood: "ecstatic",
        generatedAt: "2026-05-09T00:00:00Z",
      }).ok,
    ).toBe(false);
  });
});
