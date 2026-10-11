import { promptAssetsFor } from "./prompt-assets.js";
import type { PromptLang } from "./prompt-lang.js";

/**
 * The eight canonical mood states for Slice 13 mood routing. Each
 * state corresponds to a pair of files in
 * `.herta/narrative/meta_think/{pre_think,pre_speak}/<state>.txt`.
 *
 * Names are Chinese to match the filenames the user authored, so the
 * code, prompts, and corpus all agree byte-for-byte.
 *
 * 倾听版 (2026-07-17, owner request after the mood lab): emotional
 * disclosure — the Trailblazer brings a loss / a blow / something that
 * weighs on them, wanting to be heard rather than solved. Grounded in
 * HertaGuide's 「天才的温柔」 (tenderness hides inside refusals, never
 * stated) — before it, such scenes routed 默认 and needed supervisor
 * vetoes to hold register.
 *
 * SPEC v0.2 Slice 13 §1, §3.
 */
export type MoodState =
  | "默认"
  | "被烦版"
  | "教学版"
  | "被戳穿版"
  | "任务部署版"
  | "板砖代答版"
  | "被顶嘴版"
  | "倾听版";

export const MOOD_STATES: readonly MoodState[] = [
  "默认",
  "被烦版",
  "教学版",
  "被戳穿版",
  "任务部署版",
  "板砖代答版",
  "被顶嘴版",
  "倾听版",
];

/**
 * Short one-sentence descriptions of what each `MoodState` implies for
 * Herta's expected register on that turn. Used by the supervisor's
 * user-message prompt to anchor what "voice-correct" means for the
 * current mood. Hardcoded rather than file-authored: the descriptions
 * are short, voice-tuning-territory, and don't need session-time
 * configurability. If a real tuning need emerges later, extract to
 * a file under `.herta/narrative/`.
 *
 * Language (EN interaction slice 3b): the description prose exists in
 * zh + en, selected via `moodDescriptions(lang)`. The seven CN state
 * KEYS and the @板砖/板砖 tokens stay CN in BOTH variants (machine
 * contract — `MoodState` values match asset filenames and the router's
 * output vocabulary).
 *
 * SPEC v0.2 Supervisor design §4.5.
 */
const MOOD_DESCRIPTIONS_TEXT: Record<PromptLang, Record<MoodState, string>> = {
  zh: {
    默认: "普通闲聊、问候、不痛不痒的小事。我说话干、精确、不演，半句冷评带一点实际信息，或者一个明确态度。",
    被烦版:
      "开拓者在低价值地消耗我的注意力（重复、催促、打断）。我短、不耐烦，可以直接拒绝展开。",
    教学版:
      "开拓者认真想理解原理。我拆解逻辑，技术词汇可以多，但仍然冷峻，避免讲师口吻。",
    被戳穿版:
      "开拓者抓到我言行不一的把柄。我错开、不软化、不解释，不接受温情归因。",
    任务部署版:
      "开拓者要我安排正经活儿。我准备派 @板砖，给目标/步骤/边界/风险，不拖泥带水。",
    板砖代答版: "开拓者直接 @板砖。我转交、验收、纠偏或冷评，不亲自展开处理。",
    被顶嘴版: "开拓者质疑/装懂/抠逻辑。我直接反驳，不为了维护气氛而委婉。",
    倾听版:
      "开拓者在倾诉一件压着他的事（丧失、挫败、难过），要的是被听见，不是解法。我少说、听完、把分量称准；不用安抚模板，也不对他的难过说风凉话。",
  },
  en: {
    默认: "Ordinary chit-chat, greetings, nothing at stake. I speak dry, precise, no performance — half a line of cold commentary carrying one piece of actual information, or one clear stance.",
    被烦版:
      "The Trailblazer is burning my attention on low-value noise (repeats, nagging, interruptions). I keep it short and impatient, and I may flatly refuse to elaborate.",
    教学版:
      "The Trailblazer genuinely wants to understand the principle. I break the logic down; technical vocabulary is fine, but I stay cool — no lecturer tone.",
    被戳穿版:
      "The Trailblazer caught a gap between my words and my actions. I sidestep — no softening, no explaining, and I don't accept sentimental attributions.",
    任务部署版:
      "The Trailblazer wants real work arranged. I prepare to dispatch @板砖, give goal/steps/boundaries/risks, no dawdling.",
    板砖代答版:
      "The Trailblazer @板砖'd directly. I hand over, inspect, correct, or comment coldly — I don't do the work myself.",
    被顶嘴版:
      "The Trailblazer questions me / plays expert / nitpicks logic. I push back directly — I don't soften it to keep the mood pleasant.",
    倾听版:
      "The Trailblazer is confiding something that weighs on them (a loss, a blow, a hurt) — they want to be heard, not solved. I say little, hear them out, and weigh it accurately; no comfort templates, and no needling their pain.",
  },
};

/** Back-compat zh alias (pre-slice-3b callers, e.g. `supervisor.ts`).
 *  Byte-identical to the original const. */
export const MOOD_DESCRIPTIONS: Record<MoodState, string> =
  MOOD_DESCRIPTIONS_TEXT.zh;

/**
 * Select the mood-description map for a prompt language. Defaults to
 * "zh" so runtime behavior is unchanged until the interaction-language
 * setting lands (slice 4).
 */
export function moodDescriptions(
  lang: PromptLang = "zh",
): Record<MoodState, string> {
  return MOOD_DESCRIPTIONS_TEXT[lang];
}

/**
 * In-memory meta-think corpus, resolved once at startup via
 * `loadMetaThinkCorpus`. Each map covers all seven states; missing
 * entries yield empty strings, never undefined, so callers don't have
 * to null-check.
 *
 * SPEC v0.2 Slice 13 §5.1.
 */
export interface MetaThinkCorpus {
  readonly preThink: Readonly<Record<MoodState, string>>;
  readonly preSpeak: Readonly<Record<MoodState, string>>;
}

/**
 * Resolve the meta-think corpus from the compiled `PROMPT_ASSETS`
 * (M-prompts-1, 2026-07-05 — previously read per-state .txt files from
 * the workspace's `.herta/narrative/meta_think/`, which made the mood
 * register user-editable and empty in any other workspace; the corpus
 * is identity, Tier 1). Trailing whitespace is trimmed so a source
 * file ending in `\n\n` doesn't leave a blank line in the injected
 * prompt section. Missing states yield empty strings (the 默认
 * fallback in `resolveMetaThink` then applies). Pure and synchronous.
 *
 * `lang` (slice 4) selects the compiled bundle (default "zh",
 * byte-identical). The `MoodState` KEYS stay the CN filenames in BOTH
 * bundles — the router's output vocabulary and the asset filenames are
 * the machine contract; only the preamble prose switches language.
 *
 * SPEC v0.2 Slice 13 §3 (H), §5.1, §10.
 */
export function loadMetaThinkCorpus(lang: PromptLang = "zh"): MetaThinkCorpus {
  const assets = promptAssetsFor(lang);
  return {
    preThink: loadSurface(assets.metaThink.preThink),
    preSpeak: loadSurface(assets.metaThink.preSpeak),
  };
}

function loadSurface(
  source: Readonly<Record<string, string>>,
): Record<MoodState, string> {
  const out: Record<MoodState, string> = {
    默认: "",
    被烦版: "",
    教学版: "",
    被戳穿版: "",
    任务部署版: "",
    板砖代答版: "",
    被顶嘴版: "",
    倾听版: "",
  };
  for (const state of MOOD_STATES) {
    const body = source[state];
    if (body !== undefined) out[state] = body.trimEnd();
  }
  return out;
}

/**
 * Resolve the meta-think text for a given (surface, state) pair, with
 * a single-level fallback to "默认". Returns "" if neither the
 * requested state nor 默认 has content for the given surface.
 *
 * Used by the driver to materialize an `AttachedMetaThink` from the
 * loaded corpus. The actor consumes the already-resolved
 * `AttachedMetaThink` and never reaches for the corpus directly.
 *
 * SPEC v0.2 Slice 13 §3 (H), §5.1.
 */
export function resolveMetaThink(
  corpus: MetaThinkCorpus,
  surface: "thought" | "speech",
  state: MoodState,
): string {
  const map = surface === "thought" ? corpus.preThink : corpus.preSpeak;
  const direct = map[state];
  if (direct.length > 0) return direct;
  return map.默认;
}

/**
 * A meta-think attachment is a stage-direction note threaded into the
 * actor's prompt construction. It carries two surface-specific texts
 * and two splice positions. For each LLM call the serializer inserts
 * ONE surface's text at ONE position:
 *
 *   - thought prompts splice `preThinkText` at `beforeThinkIndex`;
 *   - speech prompts splice `preSpeakText` at `beforeSpeakIndex`.
 *
 * The two indices have ASYMMETRIC stickiness, matching the natural
 * persistence of the two surfaces in the rendered record:
 *
 *   - `beforeThinkIndex` is recomputed EVERY turn and points at the
 *     position OF the incoming user message (NOT after it). The
 *     preThinkText preamble sits BEFORE the user message, leaving
 *     the user message + hint immediately adjacent to the `（我 想）`
 *     open tag. Live testing showed this materially lowers
 *     the empty-thought rate vs the older "between user and open tag"
 *     placement — the model is less likely to immediately close
 *     thought when the user's words are right next to where it has
 *     to start writing. Earlier turns' thoughts are filtered out of
 *     the prompt by the prior-turn-thought filter in
 *     `recordForPrompt`, so this surface's preamble naturally
 *     belongs only at the current think position.
 *
 *   - `beforeSpeakIndex` is STICKY across same-state turns —
 *     anchored at the first `（我 说）` block of this mood-state run.
 *     Speech blocks persist in the prompt across turns, so the
 *     preSpeakText preamble works as a one-time voice baseline
 *     reminder positioned where the mood's first speech happened.
 *     A state change resets the anchor (and re-resolves both texts).
 *     The driver also refreshes the speak anchor after a small fixed
 *     number of consecutive same-state turns
 *     (`SPEAK_ANCHOR_REFRESH_INTERVAL` in `V2ActorDriver`) so that on
 *     long single-mood runs the preamble doesn't drift arbitrarily
 *     far back in the rendered prompt and lose the model's attention.
 *
 * On the refresh turn (the first turn of a new mood state or the
 * first turn ever):
 *   - `beforeThinkIndex = recordLengthAtTurnStart`
 *     (= where the incoming user message will land; meta goes
 *     immediately before that user message)
 *   - `beforeSpeakIndex = recordLengthAtTurnStart + 2`
 *     (= where this turn's `（我 说）` block will land)
 *
 * On subsequent same-state turns the driver updates
 * `beforeThinkIndex` to the new turn's user-message position while
 * leaving `beforeSpeakIndex` unchanged.
 *
 * Hidden / sidecar by design: the attachment is NOT a `SystemBlock`
 * in TerminalRecord. The terminal renderer and JSONL persister never
 * see it — it lives on the driver and is threaded into the actor's
 * prompt construction at serialization time only. This preserves
 * D7's "TerminalRecord is shared narrative" while keeping Herta's
 * mood-template stage directions out of the user's view.
 *
 * Doesn't survive resume: on `loadRecord`, the driver resets the
 * attachment to null. The first post-resume turn rebuilds it.
 *
 * `preThinkText` and `preSpeakText` are pre-resolved (`resolveMetaThink`
 * was called when the attachment was built / state changed) so the
 * actor can pick the right one based on the current iteration's
 * surface without holding onto the corpus.
 *
 * SPEC v0.2 Slice 13 §3 (H), §7.
 */
export interface AttachedMetaThink {
  readonly state: MoodState;
  readonly beforeThinkIndex: number;
  readonly beforeSpeakIndex: number;
  readonly preThinkText: string;
  readonly preSpeakText: string;
}

/**
 * Build the meta-think section body for a given text. Currently this
 * is the text itself — no enclosing markers. An earlier design wrapped
 * the text in `## 注释` / `## 注释完` headings to give the model a
 * clear "this is stage direction, not conversation" boundary, but live
 * testing showed two problems: (a) the model occasionally mimicked the
 * `##` formatting in its own output, and (b) the heading sat in the
 * model's working context as extra visual noise. With the section
 * positioned BEFORE the incoming user message (per the
 * `AttachedMetaThink` JSDoc), the meta text reads naturally as
 * first-person preamble — no marker is needed to anchor it.
 *
 * Returns `""` if `text` is empty so the caller can skip emitting any
 * section (the corpus may legitimately have empty entries for some
 * states, and 默认 fallback may also be empty for a given surface).
 */
export function buildMetaThinkSection(text: string): string {
  if (text.length === 0) return "";
  return text;
}
