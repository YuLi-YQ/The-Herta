import type { Episode } from "./types.js";

export interface SelectOptions {
  readonly minHertaBlocks: number;
  readonly minEpisodeChars: number;
}

export function selectEpisodes(
  episodes: readonly Episode[],
  opts: SelectOptions,
): Episode[] {
  return episodes.filter((e) => {
    if (!e.settled) return false;
    const hertaSpeech = e.blocks.filter(
      (b) => b.kind === "herta" && b.surface !== "thought",
    ).length;
    const hertaVoice = e.blocks.filter((b) => b.kind === "herta").length;
    if (hertaVoice < opts.minHertaBlocks || hertaSpeech < 1) return false;
    // Count only the conversation — the 开拓者's words and Herta's. This is
    // a VOICE-presence floor: 板砖's rows are evidence the digest keeps, but
    // they are not voice, and a head chunk of a long run used to clear the
    // floor on its op rows alone and cost a worthiness call to be rejected
    // as a task ledger (dream review 2026-09-22, finding 16).
    const chars = e.blocks.reduce(
      (n, b) => n + (b.kind === "system" ? 0 : b.text.length),
      0,
    );
    return chars >= opts.minEpisodeChars;
    // NOTE: no @板砖 / edited-file / coding-outcome requirement — non-coding
    // episodes are first-class. The LLM worthiness gate (run-dream-pass) is
    // the real discriminator.
  });
}
