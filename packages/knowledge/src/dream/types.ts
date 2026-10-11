import type { TerminalRecordBlock } from "@herta/core";
import type { ReasoningEffort } from "../llm/types.js";

export type ValidateResult = { ok: true } | { ok: false; errors: string[] };

export interface Episode {
  readonly sessionId: string;
  readonly episodeHash: string;
  readonly blocks: readonly TerminalRecordBlock[];
  /** Inclusive start / exclusive end indices into the session record. */
  readonly startIndex: number;
  readonly endIndex: number;
  readonly settled: boolean;
}

export interface CritiqueScores {
  /** 0..1. The auto-promote gate keys on `voice`. */
  readonly voice: number;
  readonly format: number;
  readonly novelty: number;
  /** 0..1 — the EPISODE's emotional charge for 黑塔/the relationship
   *  (flashbulb encoding, docs/what-is-memory.md §5; ADR 0023). Optional and
   *  never gated on: absent or unparseable extractions simply promote without
   *  a stored charge. */
  readonly charge?: number;
  /** 0..1 — does the page dramatize the SOURCE episode's core event
   *  (faithfulness gate, 2026-07-19: ADR 0024's acceptance run caught a page
   *  that kept a grief occasion's label but replaced its substance with
   *  unrelated fiction). Gated when present and finite (< minFaithfulnessScore
   *  archives); absent — e.g. a legacy critique reply — promotes ungated. */
  readonly faithfulness?: number;
}

export type EpisodeOutcome =
  | "promoted"
  | "archived"
  | "skipped"
  | "reinforced"
  | "reconsolidated";

export interface EpisodeLedgerEntry {
  readonly sessionId: string;
  readonly episodeHash: string;
  readonly outcome: EpisodeOutcome;
  readonly reason?: string;
  readonly timestamp: string;
}

export interface DreamCreatedRecord {
  readonly id: string;
  readonly file: string;
  readonly nn: number;
  readonly state: "live" | "archived";
  readonly sourceSessionId: string;
  /** The birth episode's hash. Retained as the singular alias; `sourceEpisodes`
   *  is the authoritative list (a reconsolidated record accretes hashes). */
  readonly sourceEpisodeHash: string;
  /** Every episode that contributed to this dream — birth plus any later
   *  reactivations (slice 2). Legacy records back-fill to `[sourceEpisodeHash]`. */
  readonly sourceEpisodes: readonly string[];
  readonly runId: string;
  readonly model: string;
  readonly generatedAt: string;
  readonly situationTag: string;
  readonly summary: string;
  readonly critiqueScores: CritiqueScores;
  readonly validateFeianPassed: boolean;
  /** How many times a same-move/same-scenario episode has reactivated this
   *  dream. Feeds the retention curve's usefulness term. Dormant (stays 0) until
   *  the slice-2 reconsolidation junction populates it. */
  readonly reactivationCount: number;
  /** ISO of the last reactivation; resets the decay clock. Absent until the
   *  first reactivation, at which point retention falls back to `generatedAt`. */
  readonly lastReactivatedAt?: string;
  /** When this record was born from reconsolidating an earlier dream, the id of
   *  the (now archived) record it superseded. Absent for freshly-created dreams. */
  readonly supersedes?: string;
  /** One to two FACTUAL sentences naming the underlying real-life occasion
   *  (who/what happened — not the 废案's literary angle). Extracted by the
   *  worthiness call and stored at promotion; the reactivation gate keys on it
   *  (ADR 0021). Stable across reconsolidations: a merged record copies OLD's
   *  occasion. Optional — legacy records fall back to `summary` at the gate. */
  readonly occasion?: string;
  /** Encode-time emotional charge (0..1), clamped from the critique reply's
   *  `charge` (ADR 0023 — flashbulb encoding, docs/what-is-memory.md §5).
   *  Amplifies retention salience via `retentionChargeWeight`. Additive:
   *  absent on legacy records and on unparseable extractions — retention then
   *  treats it as 0 (pure voice, byte-identical to the pre-charge formula). */
  readonly emotionalCharge?: number;
  /** Set once this LIVING record's gist has been folded into the 关于开拓者
   *  notes page (living-memory semanticization, ADR 0023 — consolidation
   *  without death, §8). One-way: never cleared, so a record folds at most
   *  once. Additive — absent on legacy records and on records that never
   *  crossed `semanticizeReactivationThreshold`. */
  readonly gistFolded?: true;
}

export interface DreamManifest {
  readonly version: 1;
  episodes: EpisodeLedgerEntry[];
  created: DreamCreatedRecord[];
  lastRunAt?: string;
  /** Archived dying dreams whose gist has not reached the 关于开拓者 page yet
   *  — names in the dream ARCHIVE dir. The fold runs at the end of a pass,
   *  after the archive move; a pass that aborted or crashed in between used
   *  to lose the gist for good (dream review 2026-09-22, finding 14). The
   *  fold reads the bodies back from the archive and clears the list only
   *  when the page was written. Absent = nothing pending. */
  pendingFold?: string[];
  /** The cutover of segmentation v2 (ADR 0069 §4 and §7, ISO). For blocks
   *  stamped at or after it, a done/noop-marker no longer ends its episode
   *  (the cut moves past Herta's verdict to the next user block), and
   *  板砖's rows no longer count toward the block cap. Set by the first pass
   *  that runs with v2 and never moved, so every episode ledgered before it
   *  keeps its hash and the reopen filter keeps matching its 废案. Absent =
   *  no pass has run with v2 yet: the old rules everywhere. */
  segmentationV2Since?: string;
}

export interface DreamConfig {
  readonly enabled: boolean;
  /** Idle window — the "user stepped away" detector before a pass is considered. */
  readonly idleMs: number;
  /** Cadence floor: minimum wall-clock time between COMPLETED full passes.
   *  Sourced at runtime from the persisted manifest `lastRunAt`, so it survives
   *  process restarts. */
  readonly cooldownMs: number;
  /** Backoff between trigger attempts, so a no-op pass (e.g. missing API key,
   *  which never advances `lastRunAt`) does not re-fire on every poll. */
  readonly minRetryMs: number;
  /** Material gate: fire if at least this many sessions are new (modified)
   *  since the last completed pass. */
  readonly minNewSessions: number;
  /** Material gate: ...or if any single new session has at least this many
   *  黑塔 turns (speech/thought blocks) on its own. */
  readonly minSessionHertaTurns: number;
  readonly episodeGapMs: number;
  readonly maxEpisodeBlocks: number;
  readonly maxEpisodeMs: number;
  readonly minHertaBlocks: number;
  readonly minEpisodeChars: number;
  readonly minVoiceScore: number;
  /** Faithfulness floor (2026-07-19): archive a draft whose critique judges
   *  it below this on "does the page dramatize the source episode's core
   *  event". Gated only when the critique returns a finite number. */
  readonly minFaithfulnessScore: number;
  /** TOTAL live 废案 budget — hand-authored seeds AND dream-created records
   *  together (M-feian-1, 2026-07-05; previously counted dream records only).
   *  This is the number that actually bounds the actor/supervisor prompt: the
   *  static prefix loads every live 废案. When a promotion would exceed it,
   *  eviction runs seed-examples-first (see the two knobs below), then
   *  weakest-dream-by-retention. */
  readonly maxLiveCount: number;
  /** Hand-authored 废案 with NN ≤ this are PERMANENTLY protected (default 2):
   *  00 is the primary voice anchor (and pickExemplars' anti-drift seed);
   *  01/02 carry the other-character relationships whose 出处 grounding the
   *  supervisor depends on — no dream about 开拓者 can replace that coverage. */
  readonly protectedSeedMaxNN: number;
  /** Hand-authored 废案 with protectedSeedMaxNN < NN ≤ this (default 6) are
   *  synthetic SEED EXAMPLES of 开拓者 interactions — not real history. When
   *  the total cap binds they are archived FIRST (highest NN first), before
   *  any dream-created record: a real shared memory always outranks the
   *  synthetic scaffolding that stood in for it. Hand-authored files with NN
   *  above this band are never touched (the D7 never-touch-user-owned stance
   *  continues to apply to everything outside the band). */
  readonly evictableSeedMaxNN: number;
  /** Retention half-life (days): a dream loses ~half its salience-weighted
   *  strength after this many idle days since its last reactivation. */
  readonly retentionHalfLifeDays: number;
  /** Usefulness gain: strength is multiplied by (1 + k·ln(1+reactivationCount)),
   *  so repeated reactivation raises retention with diminishing returns. */
  readonly retentionReactivationK: number;
  /** Stale-floor: each pass, archive any dream-created live record whose
   *  computed strength has decayed below this floor. Default 0 disables
   *  stale-forgetting (cap-eviction + exemplar ranking still use retention). */
  readonly retentionFloor: number;
  /** Spacing effect (ADR 0022): a reinforcement landing within this window
   *  of the record's last reactivation (falling back to its birth) is a
   *  retention NO-OP — no count bump, no decay-clock reset — so massed
   *  repetition can't mint an immortal memory. 0 disables the guard.
   *  Reconsolidation is exempt (a rewrite is genuinely new learning). */
  readonly reinforceSpacingMs: number;
  /** Retrieval-echo reinforcement (ADR 0023): when an episode's herta lines
   *  REUSE a live memory's move — any contiguous run of this many
   *  non-whitespace characters from the 废案's （我 说）/（我 想） lines
   *  re-appearing in the episode's herta text — that memory demonstrably
   *  served and is reinforced (deterministic, no LLM; spacing-guarded like
   *  every reinforcement). 0 disables the stage. */
  readonly echoMinChars: number;
  /** Affect weight on retention salience (ADR 0023, flashbulb encoding):
   *  salience = voice · (1 + retentionChargeWeight · emotionalCharge).
   *  0 restores pure-voice salience; records without a stored charge weigh
   *  in at charge 0 either way. */
  readonly retentionChargeWeight: number;
  /** Living-memory semanticization (ADR 0023): a live record reactivated at
   *  least this many times has proven stable — its understanding of the
   *  Trailblazer folds into the notes page WITHOUT the memory dying
   *  (consolidation without death, §8). Once per record (`gistFolded`);
   *  a failed fold retries next pass. 0 disables. */
  readonly semanticizeReactivationThreshold: number;
  /** Hard char budget for the 关于开拓者 semanticization page (the ### 记录
   *  overlay rewritten when forgetting archives a dream-created 废案). Small on
   *  purpose: every sentence must fight for its place, and the page has no
   *  half-life — the budget is what forces selectivity. */
  readonly trailblazerNotesMaxChars: number;
  /** How many of the strongest LIVING dream records get to challenge the
   *  notes page in the per-pass contradiction audit. Bounds the audit
   *  prompt's size; the weakest records were never going to overturn it. */
  readonly notesAuditMaxRecords: number;
  readonly refineMaxRetries: number;
  readonly model: string;
  /** Thinking budget for the creative generation call (default "max"). */
  readonly generationEffort: ReasoningEffort;
  /** Thinking budget for the judgment gates — worthiness, critique, refine,
   *  similarity (default "high"). */
  readonly gateEffort: ReasoningEffort;
  /** Most episodes the AUTOMATIC pass sends through the LLM stages in one
   *  run; the rest wait for the next pass. The host passes it to
   *  `runDreamPass` as `maxEpisodes`; a manual pass is not limited by it. */
  readonly autoPassMaxEpisodes: number;
}
