import {
  BRICK_INPUT_MENTION,
  INLINE_CODE_SPAN,
} from "@herta/core/banzhuan-alias";

/**
 * The literal backend-delegation token. MUST stay equal to BANZHUAN_TRIGGER
 * in packages/herta/src/narrative/parse.ts — a test asserts the literal so any
 * divergence is caught. Kept GUI-local (not imported from @herta/herta) so the
 * safety-critical dispatch path stays decoupled from presentation (D4).
 */
export const BANZHUAN_MENTION = "@板砖";

/**
 * The 板砖→Brick alias helpers (ADR 0015) are single-sourced in @herta/core
 * (core/src/text/banzhuan-alias.ts) — formerly hand-synced lockstep copies
 * here, in the CLI, and in the GUI main process. Re-exported so existing
 * renderer import sites (Composer, Conversation, SessionItem, TopicRail)
 * keep importing from this module:
 *   - `aliasBanzhuanPlain` — plain-string display alias for chip-less
 *     surfaces (e.g. the sidebar card preview line; `renderBanzhuanText`
 *     handles chip/code-aware surfaces instead).
 *   - `aliasBrickInput` — Composer submit-time `@brick`→`@板砖` conversion
 *     (code-span exempt) so everything downstream is unchanged.
 *   - `dealiasBrickDraft` — rewind-restored draft `@板砖`→`@Brick` round-trip.
 */
export {
  aliasBanzhuanPlain,
  aliasBrickInput,
  dealiasBrickDraft,
} from "@herta/core/banzhuan-alias";

/**
 * Drop inline-code DELIMITERS from a plain-text label (2026-07-27).
 *
 * The chip-aware surfaces render code spans as `<code>` and get this for
 * free; the compact single-line labels — the sidebar card preview, a search
 * snippet, a topic-rail title — take the plain-string path and would show a
 * user's `truncate` with its backticks intact, i.e. visible markup. They are
 * too small to carry a chip, so they simply take the inside.
 *
 * Display-only (D7), like every alias in this module: the record, the
 * prompt, and the CLI keep the delimiters.
 */
export function stripInlineCodeTicks(text: string): string {
  return text.replace(INLINE_CODE_SPAN, (span) =>
    // An empty span has nothing inside to keep — leave it literal rather
    // than silently deleting two characters.
    span.length > 2 ? span.slice(1, -1) : span,
  );
}

export type MentionNode =
  | { kind: "text"; value: string }
  /** `value` is the literal matched text: the wire token `@板砖`, or (with
   *  `matchBrickInput`) a typed `@brick`/`@Brick` with its case preserved. */
  | { kind: "mention"; value: string }
  /** A `…` inline code span, backticks INCLUDED in `value` — the node carries
   *  the LITERAL matched text and each renderer decides what to paint: the
   *  bubble drops the delimiters and sets the inside monospace (2026-07-27),
   *  the composer overlay keeps them so it stays metric-identical to the
   *  textarea beneath it. Keeping them here is what lets the two differ. */
  | { kind: "code"; value: string };

/**
 * Split `text` into text + mention + inline-code nodes. A bare `@板砖`
 * OUTSIDE backtick spans becomes a `mention` node; backtick spans become
 * `code` nodes (rendered monospace by the bubble variant, plain by the
 * composer variant — the composer overlay must stay metric-identical to
 * the textarea). Pure — no React. Mirrors `replaceBareTrigger` in parse.ts
 * (walk spans via matchAll, split the outside regions on the token). The
 * span/boundary regexes (INLINE_CODE_SPAN, BRICK_INPUT_MENTION) are the
 * shared @herta/core ones, so the tokenizer can never drift from the alias
 * helpers above.
 *
 * `opts.matchBrickInput` ALSO emits mention nodes for a typed `@brick` (any
 * case, boundary-safe — see BRICK_INPUT_MENTION), with the LITERAL matched
 * text as the value. This is for the EN composer overlay only: what the user
 * actually types must chip, and the renderer shows the node's literal value
 * so the overlay never drifts from the textarea's metrics. Committed records
 * never contain `@brick` (the composer translates it to the wire token on
 * send), so bubbles leave this off.
 */
export function tokenizeBanzhuanMentions(
  text: string,
  opts?: { readonly matchBrickInput?: boolean },
): MentionNode[] {
  const nodes: MentionNode[] = [];
  const pushText = (s: string): void => {
    if (s.length === 0) return;
    if (opts?.matchBrickInput !== true) {
      nodes.push({ kind: "text", value: s });
      return;
    }
    // Split the plain-text run on typed @brick mentions (case preserved).
    let last = 0;
    for (const m of s.matchAll(BRICK_INPUT_MENTION)) {
      const idx = m.index ?? 0;
      if (idx > last) nodes.push({ kind: "text", value: s.slice(last, idx) });
      nodes.push({ kind: "mention", value: m[0] });
      last = idx + m[0].length;
    }
    if (last < s.length) nodes.push({ kind: "text", value: s.slice(last) });
  };
  const splitOutside = (segment: string): void => {
    const parts = segment.split(BANZHUAN_MENTION);
    for (let i = 0; i < parts.length; i++) {
      pushText(parts[i] ?? "");
      if (i < parts.length - 1) nodes.push({ kind: "mention", value: "@板砖" });
    }
  };
  let last = 0;
  for (const m of text.matchAll(INLINE_CODE_SPAN)) {
    const idx = m.index ?? 0;
    splitOutside(text.slice(last, idx));
    nodes.push({ kind: "code", value: m[0] }); // backticks included — no chip
    last = idx + m[0].length;
  }
  splitOutside(text.slice(last));
  return nodes;
}
