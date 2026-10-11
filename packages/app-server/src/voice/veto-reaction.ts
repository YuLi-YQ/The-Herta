import { pickClipStemAvoiding } from "./clip-list.js";
import type { ParticleCatalog } from "./particle-catalog.js";

/**
 * The two "sigh" particle folders a veto reaction may borrow from
 * (`particle/唉`, `particle/哎`). Exact folder names — the pool draws from
 * these only. For the eligibility check, however, any particle token that
 * BEGINS with one of these (哎呀, 唉？, …) counts as "a sigh already played
 * this turn": a 哎呀-opener followed by a veto-哎 is the same
 * two-sighs-in-one-breath problem the check exists to avoid.
 */
const SIGH_TOKENS: readonly string[] = ["唉", "哎"];

/** What the veto moment should sound like. */
export type VetoReaction =
  | {
      readonly kind: "cue";
      readonly category: string;
      readonly clipId: string;
      /** true when the clip came from the flat `veto/` folder — the caller
       *  updates its last-veto-clip repeat-avoidance state only then. */
      readonly fromVetoFolder: boolean;
    }
  | { readonly kind: "silence" };

export interface VetoReactionInput {
  /** Flat `veto/` clip stems (may be empty — that case degrades to silence). */
  readonly vetoClips: readonly string[];
  /** The `veto/` clip the previous veto played, for repeat avoidance. */
  readonly lastVetoClip: string | null;
  /** The sigh the previous veto roll played, as its `<category>/<clipId>`
   *  key — two consecutive sigh cases never repeat the same wav (when an
   *  alternative exists), mirroring `lastVetoClip`. */
  readonly lastSighClip: string | null;
  /** The particle catalog, for the sigh folders. */
  readonly particleCatalog: ParticleCatalog;
  /** The particle token cued at this turn's first speech, or null when the
   *  speech didn't lead with one. */
  readonly particleTokenThisTurn: string | null;
  /** Injected random source; the roll consumes one draw for the case
   *  selection and one more for the clip pick (when a clip case wins). */
  readonly random: () => number;
}

/** One (folder, clip) candidate in the sigh pool. */
interface SighClip {
  readonly token: string;
  readonly clipId: string;
}

/** The `<category>/<clipId>` key a sigh cue is remembered by (lastSighClip). */
function sighKey(c: SighClip): string {
  return `particle/${c.token}/${c.clipId}`;
}

/**
 * The sigh candidates for this veto: every variant under the exact 唉 / 哎
 * folders — EMPTY (ineligible) when this turn's speech already cued a
 * sigh-family particle. The sigh the previous roll played is excluded when
 * an alternative exists (cross-turn repeat avoidance; a single-clip pool
 * keeps the unavoidable repeat, like pickClipStemAvoiding).
 */
function sighClipPool(input: VetoReactionInput): readonly SighClip[] {
  const played = input.particleTokenThisTurn;
  if (played !== null && SIGH_TOKENS.some((t) => played.startsWith(t))) {
    return [];
  }
  const pool: SighClip[] = [];
  for (const token of SIGH_TOKENS) {
    const stems = input.particleCatalog.variants.get(token) ?? [];
    for (const clipId of stems) pool.push({ token, clipId });
  }
  if (input.lastSighClip === null || pool.length <= 1) return pool;
  const fresh = pool.filter((c) => sighKey(c) !== input.lastSighClip);
  // `lastSighClip` wasn't in the pool → fresh === pool; pick from the full set.
  return fresh.length > 0 ? fresh : pool;
}

/**
 * Decide what the supervisor-veto moment sounds like (user request
 * 2026-07-11, refining SPEC 2026-06-23 veto-voice). Instead of always a full
 * "catching-herself" line, roll one of three reactions:
 *
 *   A. a `veto/` clip — the original behavior, with the same consecutive
 *      repeat avoidance;
 *   B. a short sigh from `particle/唉` or `particle/哎` — only when this
 *      turn's speech didn't already cue a sigh-family particle;
 *   C. silence — the retract morph alone carries the beat.
 *
 * Weights (user 2026-07-11): 40 / 40 / 20 when B is eligible — silence at a
 * full third read as too frequent. When B is ineligible its mass
 * redistributes proportionally: A/C split 2:1 (≈67/33). Within B every
 * non-repeat clip across both folders is equally likely. Pure and
 * deterministic under an injected `random`; a clip case that finds no clips
 * (empty `veto/` folder) degrades to silence, matching the old best-effort
 * behavior.
 */
export function pickVetoReaction(input: VetoReactionInput): VetoReaction {
  const sighPool = sighClipPool(input);
  const r = input.random();
  const choice: "veto" | "sigh" | "silence" =
    sighPool.length > 0
      ? r < 0.4
        ? "veto"
        : r < 0.8
          ? "sigh"
          : "silence"
      : r < 2 / 3
        ? "veto"
        : "silence";

  if (choice === "sigh") {
    const idx = Math.min(
      sighPool.length - 1,
      Math.floor(input.random() * sighPool.length),
    );
    const pick = sighPool[idx];
    if (pick === undefined) return { kind: "silence" };
    return {
      kind: "cue",
      category: `particle/${pick.token}`,
      clipId: pick.clipId,
      fromVetoFolder: false,
    };
  }

  if (choice === "veto") {
    const clipId = pickClipStemAvoiding(
      input.vetoClips,
      input.random,
      input.lastVetoClip,
    );
    if (clipId === null) return { kind: "silence" };
    return { kind: "cue", category: "veto", clipId, fromVetoFolder: true };
  }

  return { kind: "silence" };
}
