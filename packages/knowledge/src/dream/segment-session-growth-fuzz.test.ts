/**
 * Episode-segmentation growth-stability fuzz (2026-07-09). The point-wise
 * segment-session.test.ts pins ONE known incident each; this file enumerates
 * the PERMUTATION space of records (block kinds x timestamp presence x gap
 * sizes x markers) and asserts the INVARIANTS that must hold for every
 * combination — the unknown-unknowns the reopen own-dream filter silently
 * bets its correctness on.
 *
 * The load-bearing property (P-GROWTH):
 *   Segment record R -> episodes E. Append blocks to form R' such that the
 *   FIRST appended block's timestamp is MORE than episodeGapMs after R's last
 *   block's timestamp (a real idle-gap boundary at the seam). Re-segment
 *   R' -> E'. Then EVERY episode in E appears IDENTICALLY (same episodeHash
 *   AND same [startIndex, endIndex)) as the leading prefix of E'. Appending
 *   only ever creates NEW episodes; it never mutates an existing episode's
 *   hash or range. This is EXACTLY why prompt-exclusions.ts can hash-match
 *   old dreamed episodes against a re-segmentation of the grown record. If
 *   P-GROWTH is false, that filter is silently wrong.
 *
 * Invariants:
 *   G1. Determinism — segmentSession(id, R, opts) deep-equals itself across
 *       repeated calls (hashes + ranges + settled).
 *   G2. Coverage — episodes partition [0, R.length): first.start == 0,
 *       contiguous, last.end == R.length, none empty, none over
 *       maxEpisodeBlocks; concatenated blocks reconstruct R; each stored hash
 *       equals episodeHash(R.slice(start, end)).
 *   G3. Settled — e.settled === (e.endIndex < R.length) === isSettled(...).
 *   G4. P-GROWTH — with a real idle gap at the seam, E is an exact prefix of
 *       E' (hash + range), and E' has strictly MORE episodes than E.
 *
 * Boundary-priority, contrast, and isSettled cases are pinned as explicit
 * deterministic tests below the sweeps.
 */
import type { TerminalRecordBlock } from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  countsTowardBlockCap,
  episodeHash,
  isSettled,
  type SegmentOptions,
  segmentSession,
} from "./segment-session.js";

// ── Deterministic PRNG (no Math.random — reproducible failures) ──────────
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Fixed base epoch (constant, never Date.now/new Date) ─────────────────
// All timestamps are a fixed UTC date + an integer ms offset. Only DIFFERENCES
// matter to the segmenter; the absolute anchor is irrelevant. Offsets stay
// well under 24h (bounded record/step sizes), so a single-day formatter that
// Date.parse round-trips exactly is sufficient — no calendar arithmetic.
const BASE_ISO_DATE = "2026-06-18";
const DAY_MS = 24 * 60 * 60 * 1000;
const GAP_MS = 20 * 60_000; // episodeGapMs used by every OPTS variant

const pad = (n: number, width: number): string =>
  String(n).padStart(width, "0");

/** Fixed-date ISO from an ms offset in [0, DAY_MS). */
function formatIso(offsetMs: number): string {
  if (offsetMs < 0 || offsetMs >= DAY_MS) {
    throw new Error(`offset ${offsetMs} out of single-day range`);
  }
  const ms = offsetMs % 1000;
  const totalSec = Math.floor(offsetMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${BASE_ISO_DATE}T${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}Z`;
}

// ── Atom corpus ──────────────────────────────────────────────────────────
type Gen = "user" | "speech" | "thought" | "done" | "noop" | "op";

/** Weighted so conversational turns dominate and markers are the spice.
 *  Plain 板砖 op rows (2026-09-23) exercise v2's block cap, which counts
 *  only the conversation (ADR 0069 §7). */
const KINDS: readonly Gen[] = [
  "user",
  "speech",
  "thought",
  "user",
  "speech",
  "done",
  "noop",
  "op",
  "op",
];

/** Step atoms as multiples of GAP_MS: sub-gap (stay together), == gap (no
 *  split, strict >), and > gap (idle split). All integers, all < DAY_MS. */
const STEP_MS: readonly number[] = [
  5_000,
  GAP_MS / 4,
  GAP_MS / 2,
  GAP_MS,
  Math.floor(GAP_MS * 1.2),
  Math.floor(GAP_MS * 1.5),
];

const TEXT_ATOMS: readonly string[] = [
  "fix",
  "run",
  "ok",
  "err",
  "x",
  "the",
  ".",
  " ",
  "note",
  "diff",
];

function randomString(rng: () => number, maxAtoms: number): string {
  const n = Math.floor(rng() * maxAtoms);
  let s = "";
  for (let i = 0; i < n; i++) {
    s += TEXT_ATOMS[Math.floor(rng() * TEXT_ATOMS.length)] ?? "";
  }
  return s;
}

const pickStep = (rng: () => number): number =>
  STEP_MS[Math.floor(rng() * STEP_MS.length)] ?? GAP_MS;
const pickKind = (rng: () => number): Gen =>
  KINDS[Math.floor(rng() * KINDS.length)] ?? "user";

function mkBlock(
  gen: Gen,
  text: string,
  at: string | undefined,
): TerminalRecordBlock {
  const stamp = at !== undefined ? { at } : {};
  switch (gen) {
    case "user":
      return { kind: "user", text, ...stamp };
    case "speech":
      return { kind: "herta", surface: "speech", text, ...stamp };
    case "thought":
      return { kind: "herta", surface: "thought", text, ...stamp };
    case "done":
      return {
        kind: "system",
        label: "差分协处理器",
        body: text,
        role: "done-marker",
        ...stamp,
      };
    case "noop":
      return {
        kind: "system",
        label: "差分协处理器",
        body: text,
        role: "noop-marker",
        ...stamp,
      };
    case "op":
      return {
        kind: "system",
        label: "差分协处理器",
        body: `Reading ${text}`,
        digest: { kind: "op", verb: "Reading", arg: text },
        ...stamp,
      };
  }
}

function stampBlock(b: TerminalRecordBlock, at: string): TerminalRecordBlock {
  return { ...b, at };
}

interface GenOpts {
  readonly forceLastStamped: boolean;
  readonly allowMalformed: boolean;
}

function randomRecord(
  rng: () => number,
  maxBlocks: number,
  gopts: GenOpts,
): { record: TerminalRecordBlock[]; lastOffset: number } {
  const n = 1 + Math.floor(rng() * maxBlocks);
  const record: TerminalRecordBlock[] = [];
  let offset = 0;
  for (let i = 0; i < n; i++) {
    offset += pickStep(rng);
    const gen = pickKind(rng);
    const text = randomString(rng, 4);
    const roll = rng();
    let at: string | undefined;
    if (gopts.allowMalformed && roll < 0.08) {
      at = `not-a-date-${i}`; // unparseable -> treated as timestamp-less
    } else if (roll < 0.3) {
      at = undefined; // timestamp-less -> exercises the (d) fallback path
    } else {
      at = formatIso(offset);
    }
    record.push(mkBlock(gen, text, at));
  }
  if (gopts.forceLastStamped) {
    const last = record[n - 1];
    if (last !== undefined) record[n - 1] = stampBlock(last, formatIso(offset));
  }
  return { record, lastOffset: offset };
}

/** Grow R with a guaranteed idle-gap seam: the first appended block is stamped
 *  more than GAP_MS after `lastOffset` (R's forced-stamped last block). */
function grow(
  rng: () => number,
  base: readonly TerminalRecordBlock[],
  lastOffset: number,
): TerminalRecordBlock[] {
  const seamStep = Math.floor(GAP_MS * 1.5); // > GAP_MS for every OPTS variant
  const m = 1 + Math.floor(rng() * 5);
  const appended: TerminalRecordBlock[] = [];
  let offset = lastOffset + seamStep;
  for (let j = 0; j < m; j++) {
    const gen = pickKind(rng);
    const text = randomString(rng, 4);
    let at: string | undefined;
    if (j === 0) {
      at = formatIso(offset); // seam block MUST be stamped
    } else {
      at = rng() < 0.3 ? undefined : formatIso(offset);
    }
    appended.push(mkBlock(gen, text, at));
    offset += pickStep(rng);
  }
  return [...base, ...appended];
}

// ── OPTS variants ────────────────────────────────────────────────────────
const OPTS_DEFAULT: SegmentOptions = {
  episodeGapMs: GAP_MS,
  maxEpisodeBlocks: 60,
  maxEpisodeMs: 45 * 60_000,
};
const OPTS_TIGHT: SegmentOptions = {
  episodeGapMs: GAP_MS, // keep == so the 1.5*GAP seam stays a real idle gap
  maxEpisodeBlocks: 3,
  maxEpisodeMs: 30 * 60_000,
};
// Segmentation v2 (ADR 0069 §4, §7) with a cutover before every stamp: each
// stamped marker defers its cut to the next user block, and stamped system
// rows do not count toward the block cap.
const OPTS_VARIANTS: readonly (readonly [string, SegmentOptions])[] = [
  ["default", OPTS_DEFAULT],
  ["tight", OPTS_TIGHT],
  ["v2", { ...OPTS_DEFAULT, segmentationV2SinceMs: 0 }],
  ["v2-tight", { ...OPTS_TIGHT, segmentationV2SinceMs: 0 }],
];

// ── Labels / summaries ───────────────────────────────────────────────────
function desc(rec: readonly TerminalRecordBlock[]): string {
  return JSON.stringify(
    rec.map((b) => [
      b.kind === "herta" ? b.surface : b.kind === "system" ? b.role : "user",
      b.at ?? null,
      b.kind === "system" ? b.body : b.text,
    ]),
  );
}

type EpSumm = { h: string; s: number; e: number; settled: boolean };
const summ = (eps: ReturnType<typeof segmentSession>): EpSumm[] =>
  eps.map((ep) => ({
    h: ep.episodeHash,
    s: ep.startIndex,
    e: ep.endIndex,
    settled: ep.settled,
  }));

// ── Invariant checkers ───────────────────────────────────────────────────
function checkCoverage(
  label: string,
  record: readonly TerminalRecordBlock[],
  opts: SegmentOptions,
  eps: ReturnType<typeof segmentSession>,
): void {
  if (record.length === 0) {
    expect(eps, `${label} :: empty record must yield no episodes`).toEqual([]);
    return;
  }
  expect(
    eps.length,
    `${label} :: no episodes for non-empty record`,
  ).toBeGreaterThan(0);
  expect(
    eps[0]?.startIndex,
    `${label} :: first episode does not start at 0`,
  ).toBe(0);
  expect(
    eps.at(-1)?.endIndex,
    `${label} :: last episode does not end at record length`,
  ).toBe(record.length);

  const reconstructed: TerminalRecordBlock[] = [];
  for (let i = 0; i < eps.length; i++) {
    const ep = eps[i];
    if (ep === undefined) continue;
    // G2 — non-empty, contiguous, capped.
    expect(
      ep.endIndex,
      `${label} :: empty/inverted episode ${i}`,
    ).toBeGreaterThan(ep.startIndex);
    if (i > 0) {
      expect(
        ep.startIndex,
        `${label} :: gap/overlap between episode ${i - 1} and ${i}`,
      ).toBe(eps[i - 1]?.endIndex);
    }
    // The cap counts every block before the v2 cutover and only the
    // conversation after it (ADR 0069 §7).
    expect(
      ep.blocks.filter((b) => countsTowardBlockCap(b, opts)).length,
      `${label} :: episode ${i} exceeds maxEpisodeBlocks`,
    ).toBeLessThanOrEqual(opts.maxEpisodeBlocks);
    expect(
      ep.blocks.length,
      `${label} :: episode ${i} block count != range width`,
    ).toBe(ep.endIndex - ep.startIndex);
    // G2 — stored hash equals a fresh hash of the same slice.
    expect(
      ep.episodeHash,
      `${label} :: episode ${i} hash != episodeHash(slice)`,
    ).toBe(episodeHash(record.slice(ep.startIndex, ep.endIndex)));
    // G3 — settled correctness.
    expect(ep.settled, `${label} :: episode ${i} settled flag wrong`).toBe(
      ep.endIndex < record.length,
    );
    expect(ep.settled, `${label} :: episode ${i} settled != isSettled`).toBe(
      isSettled(ep.endIndex, record.length),
    );
    for (const b of ep.blocks) reconstructed.push(b);
  }
  // G2 — concatenated ranges reconstruct R exactly.
  expect(
    reconstructed,
    `${label} :: concatenated episode blocks do not reconstruct R`,
  ).toEqual([...record]);
}

// ── Sweep 1: determinism + coverage + cap + settled ──────────────────────
describe("segment-session fuzz — coverage / determinism / cap / settled", () => {
  it("holds G1–G3 over a random record sweep (1000 records x 4 opts)", {
    timeout: 60_000,
  }, () => {
    const rng = mulberry32(0x5eed_1234);
    for (let iter = 0; iter < 1000; iter++) {
      const { record } = randomRecord(rng, 14, {
        forceLastStamped: false,
        allowMalformed: true,
      });
      for (const [optName, opts] of OPTS_VARIANTS) {
        const label = `[${optName}] ${desc(record)}`;
        const eps = segmentSession("s", record, opts);
        // G1 — determinism (same call, deep-equal projection).
        const again = segmentSession("s", record, opts);
        expect(
          summ(again),
          `${label} :: non-deterministic segmentation`,
        ).toEqual(summ(eps));
        // G2/G3.
        checkCoverage(label, record, opts, eps);
      }
    }
  });
});

// ── Sweep 1b: trailing-silence settling (ADR 0024, clocked form) ─────────
describe("segment-session fuzz — trailing-silence settling (ADR 0024)", () => {
  it("holds: non-tail settled unchanged; tail settled iff stamped-silence > gap (1000 x 4 opts)", {
    timeout: 60_000,
  }, () => {
    const rng = mulberry32(0x0024_ad24);
    for (let iter = 0; iter < 1000; iter++) {
      const { record } = randomRecord(rng, 14, {
        forceLastStamped: false,
        allowMalformed: true,
      });
      for (const [optName, opts] of OPTS_VARIANTS) {
        const label = `[${optName}] ${desc(record)}`;
        const legacy = segmentSession("s", record, opts);
        // A clock far in the future settles any provable-silence tail; a
        // clock at (or before) the last stamp never does.
        const lastStampMs = [...record]
          .reverse()
          .map((b) => (b.at === undefined ? Number.NaN : Date.parse(b.at)))
          .find((t) => Number.isFinite(t));
        const farNow =
          (lastStampMs ?? 0) + opts.episodeGapMs + 365 * 24 * 60 * 60_000;
        const clocked = segmentSession("s", record, opts, farNow);

        // Same partition (hashes + ranges) — the clock never moves boundaries.
        expect(
          clocked.map((e) => [e.episodeHash, e.startIndex, e.endIndex]),
          `${label} :: clock changed the partition`,
        ).toEqual(legacy.map((e) => [e.episodeHash, e.startIndex, e.endIndex]));

        for (let i = 0; i < clocked.length; i++) {
          const c = clocked[i];
          const l = legacy[i];
          if (c === undefined || l === undefined) continue;
          if (i < clocked.length - 1) {
            // Non-tail episodes: settled exactly as before.
            expect(
              c.settled,
              `${label} :: clock changed non-tail settled at ${i}`,
            ).toBe(l.settled);
          } else {
            // Tail: settled iff the episode carries a parseable stamp
            // (far-future clock proves silence for any stamped tail).
            const tailHasStamp = c.blocks.some(
              (b) => b.at !== undefined && Number.isFinite(Date.parse(b.at)),
            );
            expect(
              c.settled,
              `${label} :: tail settled != stamped-silence rule`,
            ).toBe(l.settled || tailHasStamp);
          }
        }

        // Clock at the last stamp itself: silence is zero — tail behavior
        // must equal legacy everywhere.
        if (lastStampMs !== undefined) {
          const atStamp = segmentSession("s", record, opts, lastStampMs);
          expect(
            atStamp.map((e) => e.settled),
            `${label} :: zero-silence clock changed settled flags`,
          ).toEqual(legacy.map((e) => e.settled));
        }
      }
    }
  });
});

// ── Sweep 2: P-GROWTH ────────────────────────────────────────────────────
describe("segment-session fuzz — P-GROWTH prefix stability", () => {
  it("holds G4: idle-gap append preserves E as an exact prefix of E' (1000 x 4 opts)", {
    timeout: 60_000,
  }, () => {
    const rng = mulberry32(0x6_9ada_55);
    for (let iter = 0; iter < 1000; iter++) {
      const { record: base, lastOffset } = randomRecord(rng, 10, {
        forceLastStamped: true,
        allowMalformed: false,
      });
      const grown = grow(rng, base, lastOffset);
      for (const [optName, opts] of OPTS_VARIANTS) {
        const label = `[${optName}] R=${desc(base)} :: R'=${desc(grown)}`;
        const E = segmentSession("s", base, opts);
        const Eprime = segmentSession("s", grown, opts);

        // Appending across a real idle gap must ADD episodes, never fewer.
        expect(
          Eprime.length,
          `${label} :: growth did not add a new episode`,
        ).toBeGreaterThan(E.length);

        // Every old episode survives IDENTICALLY (hash + range) as a prefix.
        // (settled legitimately flips false->true for the old tail episode,
        //  so it is intentionally NOT compared here.)
        for (let i = 0; i < E.length; i++) {
          const a = E[i];
          const b = Eprime[i];
          expect(b, `${label} :: E' has no episode ${i}`).toBeDefined();
          if (a === undefined || b === undefined) continue;
          expect(b.episodeHash, `${label} :: hash drift at episode ${i}`).toBe(
            a.episodeHash,
          );
          expect(
            b.startIndex,
            `${label} :: startIndex drift at episode ${i}`,
          ).toBe(a.startIndex);
          expect(b.endIndex, `${label} :: endIndex drift at episode ${i}`).toBe(
            a.endIndex,
          );
        }

        // The old tail closed exactly at the seam (== R.length).
        expect(
          E.at(-1)?.endIndex,
          `${label} :: old tail did not end at seam`,
        ).toBe(base.length);

        // Invariant 5 (2026-07-09): enforce the FULL partition/cap/fresh-hash/
        // settled contract on the GROWN record (and the base), not just on the
        // sweep-1 corpus. The appended region must satisfy every G2/G3 property
        // in its own right — otherwise a growth path could quietly emit an
        // over-cap or non-contiguous episode that P-GROWTH's prefix check,
        // which only inspects the OLD episodes, would never notice.
        checkCoverage(`${label} [base]`, base, opts, E);
        checkCoverage(`${label} [grown]`, grown, opts, Eprime);
      }
    }
  });
});

// ── Boundary-priority isolation (deterministic) ──────────────────────────
const u = (text: string, at?: string): TerminalRecordBlock => ({
  kind: "user",
  text,
  ...(at ? { at } : {}),
});
const h = (text: string, at?: string): TerminalRecordBlock => ({
  kind: "herta",
  surface: "speech",
  text,
  ...(at ? { at } : {}),
});
const done = (at?: string): TerminalRecordBlock => ({
  kind: "system",
  label: "差分协处理器",
  body: "完成",
  role: "done-marker",
  ...(at ? { at } : {}),
});
const noop = (at?: string): TerminalRecordBlock => ({
  kind: "system",
  label: "差分协处理器",
  body: "noop",
  role: "noop-marker",
  ...(at ? { at } : {}),
});

describe("segment-session — boundary rule isolation", () => {
  it("(a) idle gap: a >episodeGapMs adjacency splits", () => {
    const rec = [
      u("a", formatIso(0)),
      u("b", formatIso(Math.floor(GAP_MS * 1.5))),
    ];
    const eps = segmentSession("s", rec, OPTS_DEFAULT);
    expect(eps).toHaveLength(2);
    expect(eps[0]?.endIndex, "idle-gap boundary index").toBe(1);
  });

  it("(a) a gap exactly == episodeGapMs does NOT split (strict >)", () => {
    const rec = [u("a", formatIso(0)), u("b", formatIso(GAP_MS))];
    expect(segmentSession("s", rec, OPTS_DEFAULT)).toHaveLength(1);
  });

  it("(b) done-marker splits with sub-gap timestamps (no idle gap)", () => {
    const rec = [
      u("q", formatIso(0)),
      done(formatIso(5_000)),
      u("next", formatIso(10_000)),
    ];
    const eps = segmentSession("s", rec, OPTS_DEFAULT);
    expect(eps).toHaveLength(2);
    // Boundary is AFTER the marker; no split at index 1 (u->done, tiny gap).
    expect(eps[0]?.endIndex, "done-marker boundary index").toBe(2);
  });

  it("(b) noop-marker splits with sub-gap timestamps", () => {
    const rec = [
      u("q", formatIso(0)),
      noop(formatIso(5_000)),
      u("next", formatIso(10_000)),
    ];
    const eps = segmentSession("s", rec, OPTS_DEFAULT);
    expect(eps).toHaveLength(2);
    expect(eps[0]?.endIndex, "noop-marker boundary index").toBe(2);
  });

  it("(c) duration cap splits a gapless run without any idle gap", () => {
    // Steps of GAP/2 (10min < 20min episodeGapMs) so (a) never fires; cumulative
    // exceeds maxEpisodeMs (45min) at @50min -> split before that block.
    const step = GAP_MS / 2;
    const rec = Array.from({ length: 6 }, (_, i) =>
      u(`m${i}`, formatIso(i * step)),
    );
    const eps = segmentSession("s", rec, OPTS_DEFAULT);
    expect(eps).toHaveLength(2);
    expect(eps[0]?.startIndex).toBe(0);
    expect(eps[0]?.endIndex, "duration-cap boundary index").toBe(5);
    // No single adjacency exceeded the gap -> the split is the cap, not idle.
    for (let i = 1; i < rec.length; i++) {
      expect(step, "sub-gap step precondition").toBeLessThan(
        OPTS_DEFAULT.episodeGapMs,
      );
    }
  });

  it("(d) per-turn fallback: timestamp-less herta->user splits", () => {
    const rec = [u("q1"), h("a1"), u("q2"), h("a2"), u("q3"), h("a3")];
    const eps = segmentSession("s", rec, OPTS_DEFAULT);
    expect(eps).toHaveLength(3);
    expect(eps.every((e) => e.blocks.length === 2)).toBe(true);
  });

  it("(d) fallback does NOT split user->herta / herta->herta / user->user", () => {
    expect(segmentSession("s", [u("a"), h("b")], OPTS_DEFAULT)).toHaveLength(1);
    expect(segmentSession("s", [h("a"), h("b")], OPTS_DEFAULT)).toHaveLength(1);
    expect(segmentSession("s", [u("a"), u("b")], OPTS_DEFAULT)).toHaveLength(1);
  });

  it("(d) is a FALLBACK: with timestamps present, herta->user does NOT split", () => {
    const rec = [h("a", formatIso(0)), u("b", formatIso(5_000))];
    expect(segmentSession("s", rec, OPTS_DEFAULT)).toHaveLength(1);
  });

  it("maxEpisodeBlocks caps even a single unbroken timestamp-less run", () => {
    const rec = Array.from({ length: 7 }, (_, i) => u(`m${i}`));
    const eps = segmentSession("s", rec, {
      ...OPTS_DEFAULT,
      maxEpisodeBlocks: 3,
    });
    expect(eps.every((e) => e.blocks.length <= 3)).toBe(true);
    // 7 blocks, cap 3 -> [0,3) [3,6) [6,7)
    expect(eps).toHaveLength(3);
  });
});

// ── Contrast: the property's boundary (no gap CAN mutate the tail) ────────
describe("segment-session — P-GROWTH boundary (contrast)", () => {
  it("sub-gap append CAN extend the last unsettled episode (hash changes)", () => {
    const R = [u("a", formatIso(0)), h("b", formatIso(GAP_MS / 4))];
    const E = segmentSession("s", R, OPTS_DEFAULT);
    expect(E).toHaveLength(1);

    // Append with a SUB-gap timestamp, no marker, herta->herta (no fallback):
    // no boundary at the seam -> the last episode is EXTENDED, its hash drifts.
    const grownNoGap = [...R, h("c", formatIso(GAP_MS / 2))];
    const Eno = segmentSession("s", grownNoGap, OPTS_DEFAULT);
    expect(Eno, "sub-gap append should not add an episode").toHaveLength(1);
    expect(
      Eno[0]?.episodeHash,
      "without the idle gap the old tail hash is NOT preserved",
    ).not.toBe(E[0]?.episodeHash);
  });

  it("the SAME append across a real idle gap DOES preserve the old tail", () => {
    const R = [u("a", formatIso(0)), h("b", formatIso(GAP_MS / 4))];
    const E = segmentSession("s", R, OPTS_DEFAULT);
    const grownGap = [
      ...R,
      h("c", formatIso(GAP_MS / 4 + Math.floor(GAP_MS * 1.5))),
    ];
    const Eg = segmentSession("s", grownGap, OPTS_DEFAULT);
    expect(Eg).toHaveLength(2);
    expect(Eg[0]?.episodeHash, "idle-gap append preserves the old tail").toBe(
      E[0]?.episodeHash,
    );
  });
});

// ── isSettled directly ───────────────────────────────────────────────────
describe("isSettled — fuzz", () => {
  it("settled iff a later block exists (end < length)", () => {
    const rng = mulberry32(0x1_5e77_1ed);
    for (let i = 0; i < 1000; i++) {
      const len = Math.floor(rng() * 50);
      const end = Math.floor(rng() * (len + 5));
      expect(isSettled(end, len), `end=${end} len=${len}`).toBe(end < len);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Invariants added 2026-07-09 (completeness-critic follow-up). These guard
// the consumer contract (prompt-exclusions.ts) directly, not just the
// segmenter's own coverage properties.
// ─────────────────────────────────────────────────────────────────────────

/** The EXACT projection episodeHash() hashes over: [kind, tag, text] per
 *  block. Mirrors segment-session.ts::episodeHash — `at` and system `role`
 *  are INTENTIONALLY excluded. Used to assert "same hash ⟺ same projection"
 *  is a real, index/position-independent claim (guards against someone folding
 *  startIndex or a timestamp into the hash). */
function normalizeSlice(
  blocks: readonly TerminalRecordBlock[],
): [string, string, string][] {
  return blocks.map((b) => [
    b.kind,
    b.kind === "herta" ? b.surface : b.kind === "system" ? b.label : "user",
    b.kind === "system" ? b.body : b.text,
  ]);
}

/** Faithful mirror of prompt-exclusions.ts's Map<hash, endIndex> build: iterate
 *  episodes in document order, `.set` last-writer-wins. Because segmentation is
 *  in document order (endIndex strictly increases across episodes), the value
 *  that survives for a given hash is the MAX endIndex — the LAST verbatim
 *  occurrence of that content in the record. */
function buildEpisodeEndMap(
  eps: ReturnType<typeof segmentSession>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const ep of eps) m.set(ep.episodeHash, ep.endIndex);
  return m;
}

// ── Invariant 1: hash discrimination + consumer Map<hash,endIndex> pin ─────
describe("segment-session — hash discrimination & consumer lookup (pin)", () => {
  // NOTE ON "byte-identical": the critic hypothesized that same-hash episodes
  // are byte-identical slices. Analysis shows that is FALSE in general —
  // episodeHash omits both `at` (rule (a) drops timestamps from identity) and
  // the system `role` (done-marker vs noop-marker, see invariant 4). Two
  // episodes can therefore collide on hash yet differ in bytes. What IS true,
  // and is what the consumer actually needs, is that same-hash ⟹ same NORMALIZED
  // content — the [kind, tag, text] projection the withhold decision is about.
  it("same-hash episodes within one segmentation share identical normalized content", {
    timeout: 60_000,
  }, () => {
    const rng = mulberry32(0xd15c_0001);
    for (let iter = 0; iter < 1000; iter++) {
      const { record } = randomRecord(rng, 14, {
        forceLastStamped: false,
        allowMalformed: true,
      });
      for (const [optName, opts] of OPTS_VARIANTS) {
        const label = `[${optName}] ${desc(record)}`;
        const eps = segmentSession("s", record, opts);
        const seenByHash = new Map<string, [string, string, string][]>();
        for (const ep of eps) {
          const proj = normalizeSlice(ep.blocks);
          const prior = seenByHash.get(ep.episodeHash);
          if (prior === undefined) {
            seenByHash.set(ep.episodeHash, proj);
          } else {
            // Same hash ⟹ same projection — the hash carries no positional or
            // timestamp state, so the consumer's hash lookup is content-sound.
            expect(
              proj,
              `${label} :: same hash, different normalized content`,
            ).toEqual(prior);
          }
        }
      }
    }
  });

  it("critic's duplicate record: dup episodes are byte-identical AND collapse to MAX endIndex", () => {
    // [u"ok", done, u"ok", done, u"x"] — all UNSTAMPED, so ONLY the done-marker
    // rule (b) segments. Produces two identical [u"ok", done] episodes then a
    // [u"x"] tail. Here byte-identity DOES hold (no `at`, identical role/body).
    const rec = [u("ok"), done(), u("ok"), done(), u("x")];
    const eps = segmentSession("s", rec, OPTS_DEFAULT);
    expect(eps, "duplicate record -> 3 episodes").toHaveLength(3);
    const [e0, e1, e2] = eps;
    expect(e0?.episodeHash, "dup episodes share a hash").toBe(e1?.episodeHash);
    expect(e0?.blocks, "dup episodes are byte-identical slices").toEqual(
      e1?.blocks,
    );
    expect([e0?.startIndex, e0?.endIndex], "ep0 range").toEqual([0, 2]);
    expect([e1?.startIndex, e1?.endIndex], "ep1 range").toEqual([2, 4]);
    // Consumer Map: last write wins -> MAX endIndex (4 = the LATEST occurrence),
    // NOT the first (2). This is the load-bearing lookup behavior.
    const endMap = buildEpisodeEndMap(eps);
    expect(endMap.get(e0?.episodeHash ?? ""), "map stores MAX endIndex").toBe(
      4,
    );
    expect(endMap.get(e2?.episodeHash ?? ""), "unique tail endIndex").toBe(5);
  });

  it("PIN: map(hash) == max endIndex, so `end>boundary` == verbatim-appears-anywhere-after-boundary", {
    timeout: 60_000,
  }, () => {
    // WHY THIS IS THE CORRECT ANTI-REDUNDANCY SEMANTICS (a proof, pinned):
    // prompt-exclusions.ts withholds a 废案 iff endMap.get(hash) > boundary.
    // endMap stores MAX(S) where S = the endIndices of every episode sharing
    // that hash (last-writer-wins over document order). For any threshold b:
    //     MAX(S) > b   ⟺   ∃ e ∈ S. e > b.
    // So "> boundary" is true exactly when the content is still verbatim at/
    // after the boundary in AT LEAST ONE place — precisely "appears anywhere",
    // which is the right test for pure duplication. A refactor to MIN(S) would
    // instead demand that EVERY occurrence be after the boundary (wrong: it
    // would fail to withhold content that is duplicated below the boundary but
    // also recapped above it), and this test would then go red on purpose.
    const rng = mulberry32(0xd15c_0002);
    for (let iter = 0; iter < 1000; iter++) {
      const { record } = randomRecord(rng, 16, {
        forceLastStamped: false,
        allowMalformed: true,
      });
      const eps = segmentSession("s", record, OPTS_DEFAULT);
      const label = desc(record);
      const endsByHash = new Map<string, number[]>();
      for (const ep of eps) {
        const arr = endsByHash.get(ep.episodeHash) ?? [];
        arr.push(ep.endIndex);
        endsByHash.set(ep.episodeHash, arr);
      }
      const endMap = buildEpisodeEndMap(eps);
      for (const [hash, ends] of endsByHash) {
        const max = Math.max(...ends);
        expect(endMap.get(hash), `${label} :: map(hash) != max endIndex`).toBe(
          max,
        );
        for (let b = 0; b <= record.length; b++) {
          const anyAfter = ends.some((e) => e > b);
          expect(
            (endMap.get(hash) ?? -1) > b,
            `${label} :: (max>b) != (∃e>b) @ boundary=${b}`,
          ).toBe(anyAfter);
        }
      }
    }
  });
});

// ── Invariant 2: P-GROWTH precondition — unstamped/corrupt seam drifts tail ─
describe("segment-session — P-GROWTH precondition: unstamped/corrupt seam (design-note)", () => {
  // prompt-exclusions.ts leans on P-GROWTH: appended blocks only ADD episodes,
  // so previously dreamed hashes stay stable across a reopen's re-segmentation.
  // That holds ONLY when the seam between R and the appended blocks is a real
  // boundary. The growth sweep GUARANTEES it by forcing R's last block stamped
  // (rule (a) fires). This block documents the REACHABLE legacy-reopen /
  // corrupt-timestamp failure: when R's LAST block is unstamped OR has an
  // unparseable `at`, AND is not a herta block (so the (d) herta->user fallback
  // also can't fire), the append FUSES into the old tail and its hash DRIFTS —
  // the reopen own-dream filter then fails to hash-match the dreamed episode.
  // This is a precondition of prompt-exclusions.ts ("the caller must pass a
  // record whose last block is parseable-stamped for the match to be correct"),
  // not a crash.
  it("unstamped last block: append fuses into the tail, hash DRIFTS (P-GROWTH broken)", () => {
    const R = [u("a", formatIso(0)), u("b")]; // last block unstamped, kind user
    const E = segmentSession("s", R, OPTS_DEFAULT);
    expect(E, "R is a single episode").toHaveLength(1);
    // Seam: u("b")[unstamped] -> u("c"); (a) can't (prev unstamped), (b) can't
    // (prev is user), (d) can't (prev is user, not herta) -> no boundary.
    const R2 = [...R, u("c")];
    const E2 = segmentSession("s", R2, OPTS_DEFAULT);
    expect(E2, "no boundary at seam -> still one episode").toHaveLength(1);
    expect(
      E2[0]?.episodeHash,
      "unstamped seam DRIFTS the old tail hash (P-GROWTH does NOT hold)",
    ).not.toBe(E[0]?.episodeHash);
  });

  it("corrupt/unparseable `at` on last block: parseAt->undefined, same drift", () => {
    const R = [u("a", formatIso(0)), u("b", "not-a-date")];
    const E = segmentSession("s", R, OPTS_DEFAULT);
    expect(E, "R is a single episode").toHaveLength(1);
    // A generously-spaced append: were the seam parseable it would idle-split;
    // because prev's `at` is corrupt, (a) cannot fire, and (c)'s span (1.5*GAP =
    // 30min < 45min cap) stays under maxEpisodeMs -> fuse + drift.
    const R2 = [...R, u("c", formatIso(Math.floor(GAP_MS * 1.5)))];
    const E2 = segmentSession("s", R2, OPTS_DEFAULT);
    expect(E2, "corrupt-at seam does not add an episode").toHaveLength(
      E.length,
    );
    expect(
      E2.at(-1)?.episodeHash,
      "corrupt-at seam DRIFTS the old tail hash",
    ).not.toBe(E.at(-1)?.episodeHash);
  });

  it("CONTRAST: a herta last block preserves the tail via the (d) fallback", () => {
    // Same unstamped seam, but prev.kind === "herta" and cur.kind === "user":
    // rule (d) fires and closes the old tail, so its hash is preserved. This
    // isolates the failure above to specifically the (prev != herta) && unstamped
    // corner — the reason the growth sweep forces a STAMPED seam instead.
    const R = [u("a", formatIso(0)), h("b")]; // last block unstamped herta
    const E = segmentSession("s", R, OPTS_DEFAULT);
    const R2 = [...R, u("c")]; // herta -> user, no timestamps -> (d) splits
    const E2 = segmentSession("s", R2, OPTS_DEFAULT);
    expect(E2.length, "(d) fallback adds a new episode").toBeGreaterThan(
      E.length,
    );
    expect(E2[0]?.episodeHash, "(d) fallback preserves the old tail hash").toBe(
      E[0]?.episodeHash,
    );
  });
});

// ── Invariant 3: non-monotonic timestamps (clock skew) ─────────────────────
describe("segment-session — non-monotonic timestamps / clock skew (pin)", () => {
  // A backward jump (curMs < prevMs) makes rule (a)'s `curMs - prevMs` and rule
  // (c)'s `curMs - episodeStartMs` NEGATIVE, so neither idle-gap nor duration-cap
  // can fire across it. Out-of-order stamps therefore UNDER-segment. Determinism
  // and full partition must still hold; the under-segmentation is pinned so a
  // future reorder of the boundary logic can't silently re-hash episodes.
  it("holds G1 (determinism) + G2 (partition/cap/settled) under out-of-order stamps (1000 x 4 opts)", {
    timeout: 60_000,
  }, () => {
    const rng = mulberry32(0x5ce7_0003);
    for (let iter = 0; iter < 1000; iter++) {
      // Offsets are drawn INDEPENDENTLY per block (not accumulated), so time
      // runs forward and backward arbitrarily — the clock-skew regime.
      const n = 2 + Math.floor(rng() * 10);
      const rec: TerminalRecordBlock[] = [];
      for (let i = 0; i < n; i++) {
        const gen = pickKind(rng);
        const text = randomString(rng, 4);
        const at =
          rng() < 0.2 ? undefined : formatIso(Math.floor(rng() * DAY_MS));
        rec.push(mkBlock(gen, text, at));
      }
      for (const [optName, opts] of OPTS_VARIANTS) {
        const label = `[${optName}] skew ${desc(rec)}`;
        const eps = segmentSession("s", rec, opts);
        expect(
          summ(segmentSession("s", rec, opts)),
          `${label} :: nondeterministic under skew`,
        ).toEqual(summ(eps));
        checkCoverage(label, rec, opts, eps);
      }
    }
  });

  it("PIN: a backward jump does NOT split where the same forward jump WOULD", () => {
    // Forward idle gap (> episodeGapMs) splits.
    const fwd = [
      u("a", formatIso(0)),
      u("b", formatIso(Math.floor(GAP_MS * 1.5))),
    ];
    expect(
      segmentSession("s", fwd, OPTS_DEFAULT),
      "forward idle gap splits",
    ).toHaveLength(2);
    // Same magnitude, reversed: (a) sees a negative delta -> no split. The two
    // blocks UNDER-segment into a single episode.
    const bwd = [
      u("a", formatIso(Math.floor(GAP_MS * 1.5))),
      u("b", formatIso(0)),
    ];
    const eps = segmentSession("s", bwd, OPTS_DEFAULT);
    expect(eps, "backward jump under-segments to one episode").toHaveLength(1);
    expect(
      eps[0]?.endIndex,
      "backward-skew episode spans the whole record",
    ).toBe(2);
  });
});

// ── Invariant 4: episodeHash role-sensitivity (decision-with-a-test) ───────
describe("segment-session — episodeHash role-sensitivity (design-note)", () => {
  // DECISION-WITH-A-TEST: episodeHash projects a system block as
  // [kind, label, body]; the `role` (done-marker vs noop-marker) is OMITTED.
  // So a done-marker and a noop-marker with the SAME label+body hash IDENTICALLY,
  // even though they are structurally different blocks. This is intentional —
  // for the reopen filter, episode identity is about CONTENT, not the structural
  // marker kind — but it is an accident-prone omission, so it is pinned here: a
  // future change that folds `role` into the hash flips these red on purpose,
  // forcing the decision to be re-made rather than silently changed.
  const doneX: TerminalRecordBlock = {
    kind: "system",
    label: "差分协处理器",
    body: "X",
    role: "done-marker",
  };
  const noopX: TerminalRecordBlock = {
    kind: "system",
    label: "差分协处理器",
    body: "X",
    role: "noop-marker",
  };

  it("done-marker and noop-marker with equal label+body hash the SAME", () => {
    expect(episodeHash([doneX]), "role is omitted from episodeHash").toBe(
      episodeHash([noopX]),
    );
    // Corollary (ties back to invariant 1): same hash does NOT imply
    // byte-identical blocks — here the `role` field differs.
    expect(doneX, "the blocks themselves DIFFER in role").not.toEqual(noopX);
  });

  it("segmentation: [u, doneX] and [u, noopX] produce an episode with the SAME hash", () => {
    const eDone = segmentSession("s", [u("q"), doneX], OPTS_DEFAULT);
    const eNoop = segmentSession("s", [u("q"), noopX], OPTS_DEFAULT);
    expect(eDone, "done tail -> single episode").toHaveLength(1);
    expect(eNoop, "noop tail -> single episode").toHaveLength(1);
    expect(
      eDone[0]?.episodeHash,
      "done/noop role omitted -> equal episode hash within a segmentation",
    ).toBe(eNoop[0]?.episodeHash);
  });
});
