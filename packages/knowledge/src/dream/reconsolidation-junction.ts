import { readdirSync } from "node:fs";
import type { DeepSeekClient } from "../llm/types.js";
import {
  buildMergePreservationJudge,
  buildPairwiseVoiceJudge,
  buildReconsolidationJudge,
  buildRedistillPrompt,
  buildRefinePrompt,
} from "./distill-prompt.js";
import {
  extractNarrativeOpening,
  nextFeianIndex,
  parseFeianHeader,
  validateFeian,
} from "./feian-format.js";
import { DreamTransportError, jsonCall } from "./llm-json.js";
import { liveDreamRecords, reinforceRecord } from "./manifest.js";
import {
  archiveDreamRecord,
  readTextFileResult,
  recordEpisode,
} from "./pass-ops.js";
import { promoteCandidate } from "./promote.js";
import type {
  DreamConfig,
  DreamCreatedRecord,
  DreamManifest,
  Episode,
} from "./types.js";
import {
  extractTrailblazerLines,
  validateUserLines,
} from "./user-line-gate.js";

/** Everything the junction shares with the surrounding pass. The manifest is
 *  mutated in place (same contract as the orchestrator's own helpers); the
 *  caller flushes it after the episode. */
export interface ReconsolidationContext {
  readonly client: DeepSeekClient;
  readonly cfg: DreamConfig;
  readonly manifest: DreamManifest;
  readonly narrativeDir: string;
  readonly dreamDir: string;
  readonly guide: string;
  readonly runId: string;
  readonly now: () => Date;
  /** LLM-facing prompt language of the pass (default "zh"). Threaded to every
   *  judge/re-distill/refine call so a reconsolidation in an EN corpus stays
   *  English. Structural 废案 tokens stay CN in both. */
  readonly lang?: "zh" | "en";
}

export type ReconsolidationOutcome =
  | "archived"
  | "reinforced"
  | "reconsolidated";

/** Locate the LIVE dream-created record whose manifest id matches `id` (the
 *  reactivation gate's matchedId — ADR 0021 replaced the fragile title join).
 *  Returns undefined when the id is absent, unknown, or resolves to an
 *  archived record — the junction then falls back to a plain archive of the
 *  candidate. Exported for tests. */
export function findLiveById(
  manifest: DreamManifest,
  id: string | undefined,
): DreamCreatedRecord | undefined {
  if (id === undefined || id.trim().length === 0) return undefined;
  const wanted = id.trim();
  return liveDreamRecords(manifest).find((r) => r.id === wanted);
}

/** Pairwise swap-and-confirm on VOICE, position-bias-neutralized by judging
 *  both A/B orderings. By the time this runs the merge has already passed the
 *  content-preservation judge (it keeps OLD's substance AND carries the new
 *  facet), so voice is the TIEBREAK, not a veto (ADR 0021 §3):
 *    - merged wins both orderings → accept;
 *    - SPLIT (one each, i.e. voice-indistinguishable) → accept — content
 *      growth wins a voice tie (2026-07-16 lab: a preserving merge was
 *      discarded on a split, permanently dropping the episode's new facet);
 *    - OLD wins both (or any unparseable call) → keep OLD (reinforce).
 *  Reconsolidation is rare, so the extra call is affordable. */
async function pairwiseMergedWins(
  ctx: ReconsolidationContext,
  oldFeian: string,
  merged: string,
): Promise<boolean> {
  // Ordering 1: merged as A → merged wins iff winner === "A".
  const r1 = await jsonCall<{ winner?: string }>(
    ctx.client,
    buildPairwiseVoiceJudge(merged, oldFeian, ctx.guide, ctx.lang),
    ctx.cfg.model,
    ctx.cfg.gateEffort,
  );
  if (r1 === undefined) return false; // unparseable → conservative keep-OLD
  // Ordering 2: merged as B → merged wins iff winner === "B".
  const r2 = await jsonCall<{ winner?: string }>(
    ctx.client,
    buildPairwiseVoiceJudge(oldFeian, merged, ctx.guide, ctx.lang),
    ctx.cfg.model,
    ctx.cfg.gateEffort,
  );
  if (r2 === undefined) return false;
  const mergedWinsFirst = r1.winner === "A";
  const mergedWinsSecond = r2.winner === "B";
  // Both → clear win. Split → voice tie → the preserving merge wins.
  return mergedWinsFirst || mergedWinsSecond;
}

function firstHeaderLine(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) return line;
  }
  return "";
}

/**
 * Reconsolidation junction (slice 2, extracted from the pass orchestrator;
 * reworked by ADR 0021).
 *
 * Entered when the reactivation gate marks the fresh episode a retelling of
 * the same real-life occasion as an existing dream. Instead of discarding the
 * new understanding, reactivate the matched dream:
 *
 *   judge (default-NO) ── no new understanding → reinforce-only
 *        │ yes
 *   re-distill (donor graft) → validate/refine
 *        → preservation judge (content-first: keeps OLD's substance AND
 *          contains the new facet — either false → reinforce-fallback)
 *        → pairwise swap-and-confirm on voice
 *        ├─ merged wins at least one ordering → reconsolidated (OLD superseded)
 *        └─ OLD wins both, or unparseable     → reinforce-only (keep OLD)
 *
 * Unresolvable match (unknown/archived id, vanished file) → "archived", the
 * safe pre-junction behavior. All manifest mutations are in place; a
 * DreamTransportError from any LLM call propagates BEFORE any mutation of the
 * corresponding decision, so an aborted junction leaves no partial state.
 */
export async function runReconsolidationJunction(
  ctx: ReconsolidationContext,
  ep: Episode,
  gen: { feian: string; situationTag: string },
  digest: string,
  sim: { reason?: string; matchedId?: string },
  /** The NEW episode's worthiness-extracted occasion. Only used as the merged
   *  record's occasion when OLD carries none (legacy back-fill) — the occasion
   *  is the stable identity across reconsolidations, so OLD's wins. */
  episodeOccasion?: string,
): Promise<ReconsolidationOutcome> {
  const { manifest, narrativeDir, dreamDir, cfg, now } = ctx;

  // Locate OLD by the reactivation gate's matchedId; if we can't resolve it to
  // a live record, fall back to the old archive-the-dup behavior (safe default).
  const old = findLiveById(manifest, sim.matchedId);
  if (old === undefined) {
    recordEpisode(
      manifest,
      ep,
      "archived",
      `near-dup (unresolved match): ${sim.reason ?? ""}`,
      now,
    );
    return "archived";
  }

  const oldRead = readTextFileResult(narrativeDir, old.file);
  if (oldRead.kind === "unreadable") {
    // UNREADABLE is not "gone" (audit 2026-07-24, 2.2). `reconcileDreamState`
    // already pruned every live record whose file is genuinely absent, so a
    // non-ENOENT failure here is a file the listing just confirmed exists —
    // a transient lock. Recording it terminally cost a memory twice over: the
    // retelling was consumed forever via `isEpisodeDreamed`, and OLD was left
    // live but NOT reinforced, so the reactivation vanished from the retention
    // curve too. Throw the abort the pass already uses for transport failures:
    // no ledger entry, retried next pass.
    throw new DreamTransportError(
      `could not read ${old.file} (${oldRead.code}) — leaving the episode unconsumed`,
    );
  }
  if (oldRead.kind === "absent") {
    // OLD's file genuinely vanished — nothing to reconsolidate against.
    recordEpisode(
      manifest,
      ep,
      "archived",
      `near-dup (matched file missing): ${old.file}`,
      now,
    );
    return "archived";
  }
  const oldFeian = oldRead.text;

  // Reconsolidation judge (default-NO): does this episode add new
  // understanding, or is it just a repeat?
  const judge = await jsonCall<{
    addsUnderstanding: boolean;
    newFacet?: string;
  }>(
    ctx.client,
    buildReconsolidationJudge(oldFeian, digest, ctx.lang),
    cfg.model,
    cfg.gateEffort,
  );

  const reinforceOnly = (reason: string): ReconsolidationOutcome => {
    // Spacing guard rides along (ADR 0022): a repeat within the window still
    // consumes the episode but is a retention no-op, marked in the ledger.
    const r = reinforceRecord(
      manifest,
      old.id,
      now().toISOString(),
      cfg.reinforceSpacingMs,
    );
    recordEpisode(
      manifest,
      ep,
      "reinforced",
      `${reason}${r?.spaced === true ? " (spaced)" : ""}`,
      now,
    );
    return "reinforced";
  };

  // No new understanding (or unparseable judge) → strengthen only.
  if (judge === undefined || !judge.addsUnderstanding) {
    return reinforceOnly(
      `reinforced ${old.file}: ${judge?.newFacet ?? "repeat"}`,
    );
  }

  // New understanding → re-distill (donor graft): weave the sharper moment
  // into OLD. Donor = the judge's newFacet plus the fresh NEW candidate the
  // pass already generated.
  const donorMoment = [judge.newFacet ?? "", gen.feian]
    .filter((s) => s.trim().length > 0)
    .join("\n\n---\n\n");

  // Re-distill with content-check retries (ADR 0021 follow-up): the merge
  // gets up to 1 + refineMaxRetries attempts, each rejection feeding the
  // preservation judge's named `problem` back into the next re-distill as a
  // must-fix. The 2026-07-16 live rounds showed good merges failing on
  // single-roll variance against the strict (uncertain→false) judge — one
  // blind shot wasted the whole reactivation.
  const problems: string[] = [];
  let merged: string | undefined;
  let mergedTag: string | undefined;
  for (
    let attempt = 0;
    attempt <= cfg.refineMaxRetries && merged === undefined;
    attempt++
  ) {
    const mergedResult = await jsonCall<{
      feian: string;
      situationTag?: string;
    }>(
      ctx.client,
      buildRedistillPrompt(
        oldFeian,
        donorMoment,
        ctx.guide,
        ctx.lang,
        problems,
      ),
      cfg.model,
      cfg.generationEffort,
    );

    if (mergedResult === undefined || typeof mergedResult.feian !== "string") {
      return reinforceOnly(
        `reinforce-fallback ${old.file}: re-distill unparseable`,
      );
    }

    // The candidate must clear the deterministic format gate AND the
    // user-line gate (ADR 0036) — a merge weaves OLD + donor, so its
    // 开拓者 lines must trace to the episode's real user messages or to
    // lines the OLD record already carried (validated when IT promoted).
    // Same refine loop, same corrective-first contract as the main path.
    const mergeSources = [
      ...ep.blocks
        .filter((b) => b.kind === "user")
        .map((b) => (b.kind === "user" ? b.text : "")),
      ...extractTrailblazerLines(oldFeian),
    ];
    const checkMerged = (feian: string): { ok: boolean; errors: string[] } => {
      const v = validateFeian(feian);
      const u = validateUserLines(feian, mergeSources);
      return {
        ok: v.ok && u.ok,
        errors: [...(v.ok ? [] : v.errors), ...u.errors],
      };
    };
    let candidate = mergedResult.feian;
    let mValid = checkMerged(candidate);
    for (let k = 0; !mValid.ok && k < cfg.refineMaxRetries; k++) {
      const refined = await jsonCall<{ feian?: string }>(
        ctx.client,
        buildRefinePrompt(candidate, mValid.errors, ctx.guide, ctx.lang),
        cfg.model,
        cfg.gateEffort,
      );
      if (refined === undefined || typeof refined.feian !== "string") break;
      candidate = refined.feian;
      mValid = checkMerged(candidate);
    }
    if (!mValid.ok) {
      return reinforceOnly(`reinforce-fallback ${old.file}: merged invalid`);
    }

    // Content-first accept (ADR 0021 decision 3): before any voice
    // comparison, the merge must (a) preserve OLD's substance and (b)
    // actually contain the judge's new facet. A merge that reads marginally
    // better but silently dropped either would lose that content forever.
    const preservation = await jsonCall<{
      preservesOld?: boolean;
      containsFacet?: boolean;
      problem?: string;
    }>(
      ctx.client,
      buildMergePreservationJudge(
        oldFeian,
        judge.newFacet ?? "",
        candidate,
        ctx.lang,
      ),
      cfg.model,
      cfg.gateEffort,
    );
    if (
      preservation?.preservesOld === true &&
      preservation.containsFacet === true
    ) {
      merged = candidate;
      mergedTag = mergedResult.situationTag;
      break;
    }
    problems.push(
      typeof preservation?.problem === "string" &&
        preservation.problem.trim().length > 0
        ? preservation.problem.trim()
        : ctx.lang === "en"
          ? "the previous merge dropped content (the check named no specifics — recheck completeness against BOTH sources)"
          : "上一稿丢失了内容（核对未给出具体点位——请对照两个来源重新自查完整性）",
    );
  }
  if (merged === undefined) {
    // All attempts rejected — keep OLD, strengthened; the ledger names the
    // last problem so the failure is diagnosable (same lesson as the
    // "duplicate title" ledger fix).
    const last = problems[problems.length - 1];
    return reinforceOnly(
      `reinforce-fallback ${old.file}: merge dropped content${last !== undefined ? ` (${last})` : ""}`,
    );
  }

  // Pairwise swap-and-confirm, both orderings to neutralize the judge's
  // position bias. OLD is kept only when it wins BOTH; a split accepts the
  // preserving merge (ADR 0021 §9 — ADR 0011's "a split keeps OLD" was
  // superseded, amended 2026-09-23).
  const mergedWins = await pairwiseMergedWins(ctx, oldFeian, merged);
  if (!mergedWins) {
    return reinforceOnly(`reinforce-fallback ${old.file}: pairwise kept OLD`);
  }

  // Accept: archive OLD first, then promote merged. This ordering means a
  // crash between the two steps leaves the corpus minus-one (recoverable from
  // the archive) instead of two live near-duplicates both loading into the
  // actor prefix. The index is assigned BEFORE the archive so the merged file
  // can never reuse OLD's number (which would collide with OLD's archived file
  // on a later archive of merged).
  const mergedId = `${ctx.runId}:${ep.episodeHash.slice(0, 8)}`;
  const mnn = nextFeianIndex(readdirSync(narrativeDir));
  const archivedOld = archiveDreamRecord(
    manifest,
    old,
    narrativeDir,
    dreamDir,
    `reconsolidated → superseded by ${mergedId}`,
    now,
  );
  // OLD held open elsewhere: it is still live, and promoting the merge
  // beside it would load two near-duplicates. Keep OLD, strengthened.
  if (!archivedOld.archived) {
    return reinforceOnly(
      `reinforce-fallback ${old.file}: OLD could not be archived (${archivedOld.code})`,
    );
  }
  const mergedHeader = parseFeianHeader(firstHeaderLine(merged));
  const mergedTitle =
    mergedHeader?.title ??
    parseFeianHeader(old.file.replace(/\.txt$/, ""))?.title ??
    "未命名";
  const { nn, file: mfile } = promoteCandidate({
    narrativeDir,
    dreamDir,
    title: mergedTitle,
    feianBody: merged,
    runId: ctx.runId,
    nn: mnn,
  });
  // The occasion is the stable identity across reconsolidations: the merged
  // record keeps OLD's occasion, falling back to the NEW episode's when OLD
  // carried none (legacy back-fill — ADR 0021).
  const mergedOccasion = old.occasion ?? episodeOccasion;
  manifest.created.push({
    id: mergedId,
    file: mfile,
    nn,
    state: "live",
    sourceSessionId: ep.sessionId,
    sourceEpisodeHash: ep.episodeHash,
    sourceEpisodes: [...old.sourceEpisodes, ep.episodeHash],
    runId: ctx.runId,
    model: cfg.model,
    generatedAt: now().toISOString(),
    situationTag: mergedTag ?? old.situationTag,
    summary: extractNarrativeOpening(merged),
    critiqueScores: old.critiqueScores,
    // Conservative (ADR 0023): the merge is not re-critiqued, so the merged
    // record carries OLD's encode-time emotional charge unchanged — exactly
    // like its critiqueScores above.
    ...(old.emotionalCharge !== undefined
      ? { emotionalCharge: old.emotionalCharge }
      : {}),
    validateFeianPassed: true,
    reactivationCount: old.reactivationCount + 1,
    lastReactivatedAt: now().toISOString(),
    supersedes: old.id,
    ...(mergedOccasion !== undefined ? { occasion: mergedOccasion } : {}),
  });
  recordEpisode(
    manifest,
    ep,
    "reconsolidated",
    `reconsolidated ${old.file} → ${mfile}: ${judge.newFacet ?? ""}`,
    now,
  );
  return "reconsolidated";
}
