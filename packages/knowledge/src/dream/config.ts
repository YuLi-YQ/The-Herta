import type { DreamConfig } from "./types.js";

export const DEFAULT_DREAM_CONFIG: DreamConfig = {
  // OPT-IN (owner 2026-09-21). The automatic pass runs while the user is
  // AWAY, on their API key — left on by default, someone who never opened
  // Settings → 入梦 found tokens spent on days they had not chatted. `enabled`
  // gates only that automatic pass (the idle trigger and its poll): dreams
  // already written stay in Herta's prefix, and a manual pass is unaffected.
  enabled: false,
  idleMs: 30 * 60_000, // 30 min "user stepped away" before a pass is considered
  cooldownMs: 7 * 24 * 60 * 60_000, // ≥ 7 days between completed passes
  minRetryMs: 60 * 60_000, // 1 h backoff between attempts (no-op pass guard)
  minNewSessions: 5, // "enough sessions" branch of the material gate
  minSessionHertaTurns: 25, // "long-enough single session" branch (黑塔 turns)
  episodeGapMs: 20 * 60_000, // a 20-min gap between blocks = topic boundary
  maxEpisodeBlocks: 60,
  maxEpisodeMs: 45 * 60_000, // 45 min wall-clock duration cap per episode
  minHertaBlocks: 2,
  minEpisodeChars: 200,
  minVoiceScore: 0.8,
  minFaithfulnessScore: 0.7, // the page must dramatize the SOURCE episode's
  // core event (2026-07-19 — the ADR 0024 acceptance run caught a grief
  // occasion retold as unrelated fiction); texture may be invented, substance
  // may not. Gated only when the critique returns a finite score.
  maxLiveCount: 27, // TOTAL live 废案 (seeds + dreams) — the prompt-size budget
  // (24 → 26 with the two ADR 0052 coverage seeds — 远程办公 其七/其八,
  // files 废案_08/09; 26 → 27 with 其九, 废案_13, the 2026-09-02 register
  // slice — so the dream headroom the cap left for real memories stays the
  // same 16 slots)
  protectedSeedMaxNN: 2, // 00 voice anchor; 01/02 other-character 出处 — permanent
  evictableSeedMaxNN: 6, // 03–06 synthetic seed examples — evicted first at cap
  retentionHalfLifeDays: 90, // ~half strength after 3 idle months
  retentionReactivationK: 0.5, // one reactivation ≈ +0.35× multiplier
  retentionFloor: 0.12, // forgetting ON (ADR 0023): a typical never-reactivated
  // 0.85-voice memory fades after ~8–9 idle months (0.85·2^(−Δ/90) < 0.12 →
  // Δ ≈ 255 d); reactivation resets the clock; the gist folds into the notes
  // page before the archive move; archive-not-delete keeps it recoverable.
  reinforceSpacingMs: 24 * 60 * 60_000, // spacing effect (ADR 0022): repeats
  // within a day of the last reactivation don't bump strength or reset decay
  echoMinChars: 12, // retrieval-echo reinforcement (ADR 0023): 12 contiguous
  // non-whitespace chars of CJK reused from a 废案's own lines is distinctive;
  // 0 disables the stage
  retentionChargeWeight: 0.5, // affect-weighted salience (ADR 0023): a full-
  // charge memory retains 1.5× a flat one; legacy/chargeless records unchanged
  semanticizeReactivationThreshold: 3, // living fold (ADR 0023): 3 spaced
  // reactivations = stabilized — gist joins the notes page without dying;
  // 0 disables
  refineMaxRetries: 2,
  trailblazerNotesMaxChars: 600, // the 关于开拓者 page — a few sentences, no more
  notesAuditMaxRecords: 8, // strongest living dreams that get to challenge the page
  model: "deepseek-v4-pro",
  generationEffort: "max",
  gateEffort: "high",
  // The AUTOMATIC pass's spend ceiling (dream review 2026-09-22, finding 3):
  // at most this many episodes go through the LLM stages per pass — each is
  // ~6 Pro calls, more through the reactivation junction — and the rest wait,
  // undreamed and un-ledgered, for the next pass. The first pass after opting
  // in used to walk the whole history at once. The manual CLI pass keeps its
  // own `--budget-cap-usd` and is not limited by this.
  autoPassMaxEpisodes: 24,
};

export function resolveDreamConfig(
  partial: Partial<DreamConfig> = {},
): DreamConfig {
  return { ...DEFAULT_DREAM_CONFIG, ...partial };
}
