import type { AddresseeClass, CanonChunk, CanonDocument } from "../schema.js";

/**
 * Bumps when classifyAddressee logic changes. Re-running R0 with a higher
 * version overwrites prior strata rows.
 *
 * Version 2 (2026-05-08): added Rule 4 — document-context fallback for
 * player-protagonist quest directories. Catches chunks where Herta speaks
 * to the player using a nickname (e.g. `小家伙`) without naming them.
 */
export const STRATIFY_CLASSIFIER_VERSION = 2 as const;

const SECOND_PERSON_ZH = ["你", "您", "你们"] as const;

/**
 * Trailblazer surface forms checked deterministically. Kept in priority
 * order so the player rule wins over `other_named` even when both apply.
 */
const PLAYER_ALIASES = [
  "星",
  "穹",
  "开拓者",
  "Stelle",
  "Caelus",
  "Trailblazer",
] as const;

/**
 * Document-path fragments that mark a quest as player-protagonist (the
 * player is the camera and default addressee). Used by Rule 4 only when
 * Rules 2 and 3 have already failed — i.e., Herta speaks with a
 * second-person pronoun but no entity is named in the chunk.
 *
 * Excluded by design:
 *  - `活动任务/` — event quests with mixed protagonists.
 *  - `冒险任务/` — adventure quests where the player isn't always present.
 *  - `日常任务/` — daily quests, varied.
 *  - `模拟宇宙/` — simulated universe, mixed.
 */
const PLAYER_PROTAGONIST_PATH_FRAGMENTS = [
  "plot_html/开拓任务/",
  "plot_html/开拓续闻/",
  "plot_html/同行任务/",
] as const;

export function isPlayerProtagonistDocument(path: string): boolean {
  return PLAYER_PROTAGONIST_PATH_FRAGMENTS.some((p) => path.includes(p));
}

export interface ClassifyInput {
  chunk: Pick<CanonChunk, "id" | "text" | "speakerEntityId">;
  document: Pick<CanonDocument, "kind" | "pageSubjectEntityId" | "id" | "path">;
  /**
   * All non-player canon entities the chunk text might mention. Provided
   * by the orchestrator from a precomputed alias index. Order is
   * load-bearing — Rule 3 picks the first hit.
   */
  otherEntityHits: ReadonlyArray<{ entityId: string; alias: string }>;
}

export interface ClassifyOutput {
  addresseeClass: AddresseeClass;
  addresseeEntityId?: string;
}

/**
 * Pure deterministic addressee classifier. Rules apply in priority order:
 *
 * 1. self_narration — book_readable doc whose page subject IS the speaker.
 * 2. player          — any Trailblazer alias + any second-person pronoun.
 * 3. other_named     — first non-player canon entity hit + second-person.
 * 4. player          — second-person pronoun + no other entity mentioned
 *                      AND document is in a player-protagonist directory
 *                      (`开拓任务/`, `开拓续闻/`, `同行任务/`).
 * 5. unknown         — fallthrough.
 *
 * Rule 4 catches chunks where Herta uses a nickname for the player
 * (e.g. `小家伙`) without invoking their canonical alias. By gating on
 * document genre, false positives from "Herta talks to NPC X without
 * re-naming X" stay bounded — those NPC-dialogue scenes mostly live in
 * `活动任务/` and similar non-protagonist directories which Rule 4 skips.
 *
 * No LLM. Inputs must be pre-normalized — the function does not lowercase
 * or otherwise transform text.
 */
export function classifyAddressee(input: ClassifyInput): ClassifyOutput {
  const text = input.chunk.text;

  // Rule 1: self_narration — book authored by Herta (page subject == speaker).
  if (
    input.document.kind === "book_readable" &&
    input.document.pageSubjectEntityId !== undefined &&
    input.chunk.speakerEntityId !== undefined &&
    input.document.pageSubjectEntityId === input.chunk.speakerEntityId
  ) {
    return { addresseeClass: "self_narration" };
  }

  const hasSecondPerson = SECOND_PERSON_ZH.some((p) => text.includes(p));

  // Rule 2: player — Trailblazer alias + second-person pronoun.
  const hasPlayerAlias = PLAYER_ALIASES.some((a) => text.includes(a));
  if (hasPlayerAlias && hasSecondPerson) {
    return { addresseeClass: "player" };
  }

  // Rule 3: other_named — first non-player entity mention + second-person.
  if (hasSecondPerson && input.otherEntityHits.length > 0) {
    const first = input.otherEntityHits[0];
    if (first === undefined) return { addresseeClass: "unknown" };
    return {
      addresseeClass: "other_named",
      addresseeEntityId: first.entityId,
    };
  }

  // Rule 4: player (by document context) — second-person pronoun, no other
  // entity hit (Rule 3 didn't fire), and the document is a player-
  // protagonist quest. Catches `小家伙`-style nickname addressing.
  if (hasSecondPerson && isPlayerProtagonistDocument(input.document.path)) {
    return { addresseeClass: "player" };
  }

  // Rule 5: unknown.
  return { addresseeClass: "unknown" };
}
