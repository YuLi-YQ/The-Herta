import { describe, expect, it } from "vitest";
import type { ParticleCatalog } from "./particle-catalog.js";
import { pickVetoReaction, type VetoReactionInput } from "./veto-reaction.js";

/** A scripted random source: returns the given draws in order, then 0. */
function scripted(...draws: readonly number[]): () => number {
  let i = 0;
  return () => draws[i++] ?? 0;
}

function catalog(variants: Record<string, readonly string[]>): ParticleCatalog {
  const map = new Map(Object.entries(variants));
  return {
    tokens: [...map.keys()].sort((a, b) => b.length - a.length),
    variants: map,
  };
}

/** Baseline input: veto clips present, both sigh folders present, no
 *  particle played this turn. Override per test. */
function input(overrides: Partial<VetoReactionInput>): VetoReactionInput {
  return {
    vetoClips: ["v1", "v2"],
    lastVetoClip: null,
    lastSighClip: null,
    particleCatalog: catalog({ 唉: ["01"], 哎: ["01", "02"], 嗯: ["01"] }),
    particleTokenThisTurn: null,
    random: scripted(0),
    ...overrides,
  };
}

describe("pickVetoReaction — 40/40/20 roll (sigh eligible)", () => {
  it("the veto band (r < 0.4) → a veto/ clip", () => {
    const r = pickVetoReaction(input({ random: scripted(0.0, 0.0) }));
    expect(r).toEqual({
      kind: "cue",
      category: "veto",
      clipId: "v1",
      fromVetoFolder: true,
    });
    // 0.35 pins the widened veto band (the old equal-thirds split would
    // have rolled "sigh" here).
    expect(
      pickVetoReaction(input({ random: scripted(0.35, 0.0) })),
    ).toMatchObject({ kind: "cue", category: "veto" });
  });

  it("the sigh band (0.4 ≤ r < 0.8) → a clip from particle/唉 or particle/哎", () => {
    const r = pickVetoReaction(input({ random: scripted(0.5, 0.0) }));
    expect(r).toEqual({
      kind: "cue",
      category: "particle/唉",
      clipId: "01",
      fromVetoFolder: false,
    });
    // 0.75 pins the widened sigh band (old equal-thirds → silence here).
    expect(
      pickVetoReaction(input({ random: scripted(0.75, 0.0) })),
    ).toMatchObject({ kind: "cue", category: "particle/唉" });
  });

  it("the silence band (r ≥ 0.8)", () => {
    expect(pickVetoReaction(input({ random: scripted(0.9) }))).toEqual({
      kind: "silence",
    });
    expect(pickVetoReaction(input({ random: scripted(0.8) }))).toEqual({
      kind: "silence",
    });
  });

  it("the sigh pool spans BOTH folders — a high second draw lands in 哎", () => {
    // pool = [唉/01, 哎/01, 哎/02]; draw 0.99 → index 2
    const r = pickVetoReaction(input({ random: scripted(0.5, 0.99) }));
    expect(r).toEqual({
      kind: "cue",
      category: "particle/哎",
      clipId: "02",
      fromVetoFolder: false,
    });
  });
});

describe("pickVetoReaction — sigh eligibility", () => {
  it("a 唉-opener this turn removes the sigh case (proportional 2:1 veto/silence)", () => {
    const withToken = { particleTokenThisTurn: "唉" };
    // 0.6 < 2/3 → veto (would have been "sigh" in the eligible split)
    const a = pickVetoReaction(
      input({ ...withToken, random: scripted(0.6, 0.0) }),
    );
    expect(a).toMatchObject({ kind: "cue", category: "veto" });
    // 0.7 ≥ 2/3 → silence
    const b = pickVetoReaction(input({ ...withToken, random: scripted(0.7) }));
    expect(b).toEqual({ kind: "silence" });
  });

  it("a sigh-family token (哎呀) also blocks the sigh case", () => {
    const r = pickVetoReaction(
      input({ particleTokenThisTurn: "哎呀", random: scripted(0.7) }),
    );
    expect(r).toEqual({ kind: "silence" });
  });

  it("a non-sigh particle (嗯) does NOT block the sigh case", () => {
    const r = pickVetoReaction(
      input({ particleTokenThisTurn: "嗯", random: scripted(0.5, 0.0) }),
    );
    expect(r).toMatchObject({ kind: "cue", category: "particle/唉" });
  });

  it("no sigh folders in the catalog → the same 2:1 veto/silence split", () => {
    const noSigh = { particleCatalog: catalog({ 嗯: ["01"] }) };
    const a = pickVetoReaction(
      input({ ...noSigh, random: scripted(0.6, 0.0) }),
    );
    expect(a).toMatchObject({ kind: "cue", category: "veto" });
    const b = pickVetoReaction(input({ ...noSigh, random: scripted(0.7) }));
    expect(b).toEqual({ kind: "silence" });
  });
});

describe("pickVetoReaction — sigh repeat avoidance (cross-turn)", () => {
  it("never re-picks the sigh the previous roll played (alternatives exist)", () => {
    // Pool is [唉/01, 哎/01, 哎/02]; the last roll played 唉/01 → it is
    // excluded, so the lowest draw now lands on 哎/01.
    const r = pickVetoReaction(
      input({ lastSighClip: "particle/唉/01", random: scripted(0.5, 0.0) }),
    );
    expect(r).toMatchObject({
      kind: "cue",
      category: "particle/哎",
      clipId: "01",
    });
  });

  it("a single-clip pool keeps the unavoidable repeat", () => {
    const r = pickVetoReaction(
      input({
        particleCatalog: catalog({ 唉: ["01"] }),
        lastSighClip: "particle/唉/01",
        random: scripted(0.5, 0.0),
      }),
    );
    expect(r).toMatchObject({
      kind: "cue",
      category: "particle/唉",
      clipId: "01",
    });
  });
});

describe("pickVetoReaction — veto-clip case details", () => {
  it("keeps the consecutive repeat avoidance (never re-picks lastVetoClip)", () => {
    // veto case (0.0), then the avoiding pick over ["v2"] — 0.0 → v2
    const r = pickVetoReaction(
      input({ lastVetoClip: "v1", random: scripted(0.0, 0.0) }),
    );
    expect(r).toMatchObject({ kind: "cue", category: "veto", clipId: "v2" });
  });

  it("an empty veto/ folder degrades the veto case to silence", () => {
    const r = pickVetoReaction(
      input({ vetoClips: [], random: scripted(0.0, 0.0) }),
    );
    expect(r).toEqual({ kind: "silence" });
  });
});
