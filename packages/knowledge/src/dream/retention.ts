import type { DreamConfig, DreamCreatedRecord } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60_000;

/**
 * Retention strength of a dream-created 废案 — computed on demand, never stored
 * (a stored value would go stale the moment the clock moved). Models the
 * forgetting curve from `docs/what-is-memory.md` §6/§7:
 *
 *   strength = salience · 2^(−Δdays / halfLife) · (1 + k·ln(1 + reactivations))
 *
 * - salience: the birth voice score × (1 + w·emotionalCharge) — what got the
 *   dream kept, amplified by how much the episode moved her (affect-weighted
 *   salience / flashbulb encoding, ADR 0023). Legacy records carry no stored
 *   charge → charge 0 → pure voice, byte-identical to the pre-charge formula.
 * - 2^(−Δ/halfLife) = exp(−ln2·Δ/halfLife): the decay curve, a true half-life
 *   (ADR 0011's e-folding form was amended 2026-09-23). Δ is time since the
 *   *last reactivation* (falling back to birth), so a reactivated dream
 *   resets its clock.
 * - (1 + k·ln(1+n)): usefulness bump — concave, so repeated reactivation matters
 *   with diminishing returns and never runs away.
 *
 * Pure: `nowMs` is passed in (no `Date.now()` inside), matching the pass's
 * `now`-threading so it stays deterministic under test.
 */
export function computeStrength(
  record: DreamCreatedRecord,
  nowMs: number,
  cfg: DreamConfig,
): number {
  const salience =
    record.critiqueScores.voice *
    (1 + cfg.retentionChargeWeight * (record.emotionalCharge ?? 0));
  const anchor = record.lastReactivatedAt ?? record.generatedAt;
  const anchorMs = Date.parse(anchor);
  // Unparseable/absent anchor → treat as no decay rather than NaN-poisoning the
  // score (the record still ranks by salience · usefulness).
  const deltaDays = Number.isNaN(anchorMs)
    ? 0
    : Math.max(0, (nowMs - anchorMs) / MS_PER_DAY);
  const halfLife = cfg.retentionHalfLifeDays;
  const decay = halfLife > 0 ? Math.exp((-Math.LN2 * deltaDays) / halfLife) : 1;
  const reactivations = Math.max(0, record.reactivationCount);
  const usefulness =
    1 + cfg.retentionReactivationK * Math.log(1 + reactivations);
  return salience * decay * usefulness;
}
