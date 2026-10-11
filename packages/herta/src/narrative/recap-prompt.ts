import type { PromptLang } from "./prompt-lang.js";

/** CN/EN co-located recap-prompt text (EN interaction slice 3b). The narrative
 *  fence tokens quoted inside the rules line — （我 说）/（开拓者 说） — stay
 *  CN verbatim in BOTH variants: they are the record grammar the summarizer
 *  must not emit (D2/D7/D8), not prose. */
const RECAP_TEXT = {
  zh: {
    bioIntro:
      "下面是你自传的开头，仅供参照人称、笔调与语气——照这种第一人称、自传式的写法来回忆，但绝不要照搬其中的内容或事件（这次回忆只写你和开拓者这段对话里发生的事）：",
    guideIntro: "以下是你的说话指南，回忆的语气要与之一致：",
    systemLines: (maxChars: number): readonly string[] => [
      "你是黑塔。把下面这段你与开拓者的对话，用第一人称、回忆的语气压缩成你自传里的一节。",
      "必须保留（即便压缩也不能丢）：尚未了结的请求或线索、已经确立的事实与决定、你做出的承诺、被打断前你正在做的事。",
      "也保留：开拓者透露的偏好、关系的基调。丢弃：寒暄、逐句往复、已无关的枝节。",
      "把『原始对话』当作权威事实；把『已有的回忆』当作必须原样保留的既定背景——不要改写它，只在其后接续。",
      "回忆只能写到对话实际停下的地方：还没发生的事、还没收到的东西、还没兑现的承诺，必须原样悬着，绝不能写成已经发生或已经解决。",
      "不要虚构对话里不存在的场景、媒介或引语（邮件、来电、截图、旁人）；拿不准的细节宁可略去，也不要补全。",
      `规则：不要逐句复述；不要编造；不要加标题或章节号，直接写正文；绝不使用（我 说）/（开拓者 说）对话格式——只写连贯的叙事散文；用过去/回忆时态；控制在 ${maxChars} 字以内。`,
    ],
    rollRule:
      "输出格式：只写新增的补记本身。『已有的回忆』已经在册，会自动衔接在你的补记之前——绝不要抄录、复述或改写它，一个字都不要重复；补记接着它写下去即可，是补记，不是续写小说，必须明显短于新对话本身。",
    prevRecapHeader: "【已有的回忆（已在册——衔接的上文，勿抄录）】",
    rawHeader: "【原始对话（权威事实）】",
  },
  en: {
    bioIntro:
      "Below is the opening of your autobiography, provided only as a reference for person, style, and tone — recall in that same first-person, autobiographical manner, but never copy its content or events (this recollection covers only what happened in this conversation with the Trailblazer):",
    guideIntro:
      "Below is your speaking guide; keep the recollection's tone consistent with it:",
    systemLines: (maxChars: number): readonly string[] => [
      "You are Herta. Compress the following conversation between you and the Trailblazer into one section of your autobiography, written in the first person, in the tone of a recollection.",
      "Must survive (even under compression): requests or threads not yet resolved, facts and decisions already established, promises you made, and whatever you were doing when interrupted.",
      "Also keep: preferences the Trailblazer revealed, and the tenor of the relationship. Drop: pleasantries, line-by-line back-and-forth, and tangents that no longer matter.",
      "Treat the [raw conversation] as authoritative fact; treat the [existing recollection] as fixed backstory to preserve as-is — do not rewrite it, only continue after it.",
      "The recollection ends where the conversation actually stopped: anything not yet happened, not yet received, not yet delivered must stay unresolved — never narrate it as done.",
      "Do not invent scenes, mediums, or quotes absent from the conversation (emails, calls, screenshots, bystanders); when unsure of a detail, omit it rather than fill it in.",
      // "Write in English" is EXPLICIT (2026-08-11): the output language
      // originally rode on the instruction language alone, and a live
      // recap-lab round showed flash narrating an all-English session's
      // recap in Chinese anyway. zh needs no mirror clause — zh instructions
      // over zh content have never flipped, and zh stays byte-identical.
      `Rules: do not restate line by line; do not invent anything; no headings or chapter numbers — body prose only; NEVER use the （我 说）/（开拓者 说） dialogue format — write continuous narrative prose only; use past/recollective tense; write the recollection in English; stay within ${maxChars} characters.`,
    ],
    rollRule:
      "Output format: write ONLY the new addendum. The [existing recollection] is already on file and will be joined ahead of your addendum automatically — never copy, restate, or rewrite it, not one repeated sentence; simply continue after it: an addendum, not a sequel, clearly shorter than the new conversation itself.",
    prevRecapHeader:
      "[existing recollection (on file — the text your addendum continues; do not copy)]",
    rawHeader: "[raw conversation (authoritative facts)]",
  },
} as const;

export interface BuildRecapPromptInput {
  /** Prior rolling recap (fixed backstory). null on a re-derive / first engage. */
  readonly prevRecap: string | null;
  /** Serialized newly-aged turns (a re-derive passes the full span). */
  readonly agedTurnsText: string;
  /** HertaGuide voice invariants, injected verbatim. */
  readonly guide: string;
  /** Head excerpt of HertaBio (already bounded) — a first-person autobiography
   *  voice/style anchor. Empty when not wired. Reference for tone only; its
   *  content must NOT be reproduced in the recap. */
  readonly bio: string;
  readonly maxChars: number;
  readonly isRederive: boolean;
  /** Language of the instruction prose. Defaults "zh"; structural fence
   *  tokens stay CN in both variants. */
  readonly lang?: PromptLang;
}

export function buildRecapPrompt(input: BuildRecapPromptInput): {
  system: string;
  user: string;
} {
  const text = RECAP_TEXT[input.lang ?? "zh"];
  // A roll continues a prior recap: the addendum-only output contract applies
  // then. The live lab (2026-07-17) showed rolls drifting into sequel-writing
  // — resolving still-open threads, inventing scenes — without an explicit
  // shape; the E2E lab (2026-08-11) then showed the original shape ("copy the
  // backstory verbatim, then continue") being VIOLATED: flash compressed the
  // backstory instead of copying it, and the harness stored the loss. The
  // model now writes ONLY the addendum and the RUNTIME concatenates
  // (prepareTurnRecap) — the backstory can no longer be lost to a model that
  // declines to copy, and rolls stop paying output tokens to re-type it.
  // `maxChars` on a roll is therefore the ADDENDUM budget, not the total.
  const isRoll =
    !input.isRederive &&
    input.prevRecap !== null &&
    input.prevRecap.trim().length > 0;
  const bioSection =
    input.bio.trim().length > 0 ? `\n${text.bioIntro}\n${input.bio}` : "";
  const guideSection =
    input.guide.trim().length > 0 ? `\n${text.guideIntro}\n${input.guide}` : "";
  const system = [
    ...text.systemLines(input.maxChars),
    ...(isRoll ? [text.rollRule] : []),
    bioSection,
    guideSection,
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  const parts: string[] = [];
  if (isRoll) {
    parts.push(`${text.prevRecapHeader}\n${input.prevRecap}`);
  }
  parts.push(`${text.rawHeader}\n${input.agedTurnsText}`);
  return { system, user: parts.join("\n\n") };
}

// Matches a real dialogue fence — （我 说）/（我 想）/（开拓者 说） and their
// （/…） closers — the exact record grammar the recap prompt forbids and the
// narrative parser recognizes. Restricted to the actual speaker tokens
// (我/开拓者): the previous any-speaker heuristic (`[^（）]*\s说`) also
// matched innocent spaced parentheticals like （总的来 说） or （我当时 想）,
// and every false reject counted as a summarizer FAILURE — three in a
// session opened the circuit breaker. A parenthetical with any other
// "speaker" is not parseable as a fence downstream, so rejecting it bought
// no safety. Whitespace stays `\s` (wider than the parser's U+0020) —
// cheap belt over exotic-space variants of the REAL tokens.
const DIALOGUE_FENCE = /（\/?(?:我|开拓者)\s(?:说|想)）/;

export function validateRecap(
  text: string,
  maxChars: number,
): { ok: true } | { ok: false; reason: string } {
  const t = text.trim();
  if (t.length === 0) return { ok: false, reason: "empty recap" };
  if (t.length > maxChars)
    return { ok: false, reason: `over length (>${maxChars})` };
  if (DIALOGUE_FENCE.test(t))
    return { ok: false, reason: "contains dialogue fence" };
  return { ok: true };
}
