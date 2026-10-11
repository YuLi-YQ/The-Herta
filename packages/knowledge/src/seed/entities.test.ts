import { describe, expect, it } from "vitest";
import {
  HERTA_FORM_DOLL,
  HERTA_NAME_AMBIGUOUS,
  HERTA_PERSON_PRIME,
  HERTA_PLACE_SPACE_STATION,
  HERTA_WORK_MANUSCRIPT,
} from "../schema.js";
import { PERSON_TRAILBLAZER, SEED_EDGES, SEED_ENTITIES } from "./entities.js";

describe("seed entities", () => {
  it("includes the five required Herta-namespace entities", () => {
    const ids = new Set(SEED_ENTITIES.map((e) => e.id));
    expect(ids.has(HERTA_PERSON_PRIME)).toBe(true);
    expect(ids.has(HERTA_FORM_DOLL)).toBe(true);
    expect(ids.has(HERTA_PLACE_SPACE_STATION)).toBe(true);
    expect(ids.has(HERTA_WORK_MANUSCRIPT)).toBe(true);
    expect(ids.has(HERTA_NAME_AMBIGUOUS)).toBe(true);
  });

  it("includes the player (Trailblazer) with both gender presentations as aliases", () => {
    const player = SEED_ENTITIES.find((e) => e.id === PERSON_TRAILBLAZER);
    expect(player).toBeDefined();
    if (player === undefined) return;
    expect(player.canonicalName).toBe("开拓者");
    const aliasStrings = player.aliases.map((a) => a.alias);
    expect(aliasStrings).toContain("星");
    expect(aliasStrings).toContain("穹");
    expect(aliasStrings).toContain("开拓者");
    expect(aliasStrings).toContain("Stelle");
    expect(aliasStrings).toContain("Caelus");
  });

  it("has unique entity IDs", () => {
    const ids = SEED_ENTITIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique aliases per entity", () => {
    for (const entity of SEED_ENTITIES) {
      const aliasStrings = entity.aliases.map((a) => a.alias);
      expect(new Set(aliasStrings).size).toBe(aliasStrings.length);
    }
  });

  it("never targets the ambiguous sentinel from a seed edge", () => {
    for (const edge of SEED_EDGES) {
      expect(edge.sourceEntityId).not.toBe(HERTA_NAME_AMBIGUOUS);
      expect(edge.targetEntityId).not.toBe(HERTA_NAME_AMBIGUOUS);
    }
  });

  it("has every seed-edge endpoint defined as a seed entity", () => {
    const ids = new Set(SEED_ENTITIES.map((e) => e.id));
    for (const edge of SEED_EDGES) {
      expect(ids.has(edge.sourceEntityId)).toBe(true);
      expect(ids.has(edge.targetEntityId)).toBe(true);
    }
  });
});
