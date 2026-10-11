import { estimatePromptTokens, stripDisplayUnsafe } from "@herta/core";

/**
 * Gate for 废案/记录 bodies loaded off disk into the static prefix (audit
 * BL3; rebuilt 2026-08-31, ADR 0051).
 *
 * These files come from the workspace's `.herta` narrative dir — written by
 * the Dream system and by `materializeSeedFeian`, but also an ordinary
 * directory in whatever repo the user pointed Herta at, so a foreign file
 * must not be able to SPLICE the completion prompt: leave a dialogue fence
 * open (the following EnvSet/record text would read as sitting inside it),
 * or drop a stray close that ends a block it never opened.
 *
 * History: the first version of this gate (2026-08-06) rejected any body
 * containing `（我 ` / `（/我 说）` / `→ 差分协处理器` — but those tokens ARE
 * the 废案 corpus format (every seed and every dream-distilled 废案 is a
 * dialogue transcript). It silently dropped ALL 18 live few-shots in every
 * session for 25 days; the GUI wires no `onFewShotDropped`, so nothing
 * surfaced until the owner noticed the voice had gone flat (2026-08-31).
 * The lesson is pinned by `few-shot-guard.test.ts`, which now runs EVERY
 * bundled seed through this check.
 *
 * What this guard therefore checks is STRUCTURE, not vocabulary:
 *  - dialogue fences must be balanced, unnested, and all closed by EOF;
 *  - the body must not end in a truncated fence-open (`（我 ` at EOF would
 *    visually swallow whatever the prefix concatenates next);
 *  - header / emptiness / length as before.
 *
 * Record furniture (`→ 系统`, `→ 差分协处理器` rows) is ALLOWED: it is how a
 * 废案 teaches the record grammar. A hand-dropped file can still therefore
 * FABRICATE record-shaped prose — but so can any prose at all; that risk is
 * carried by provenance (the dream pipeline's own validator at generation
 * time, and the workspace being the user's own machine), not by shape. The
 * ceiling stays low regardless: the actor holds an empty tool registry, so
 * nothing here reaches a tool call, and D4 is intact — no persona text
 * decides whether an action is allowed.
 *
 * The check lives here rather than reusing `validateFeian` because
 * `validateFeian` is in `@herta/knowledge`, which DEPENDS on `@herta/herta` —
 * importing it back would close a package cycle (see CLAUDE.md). What
 * matters at this boundary is narrower anyway: whether the body can escape
 * or splice the prompt it is pasted into.
 */

/** One dialogue fence: `（我 说）` / `（开拓者 说）` / `（我 想）` opens,
 *  `（/我 说）` closes. Speaker is free-form (dream 废案 may quote other
 *  characters); the ASCII space and full-width parens/斜线 are the grammar. */
const FENCE_RE = /（(\/?)([^（）/\n]{1,16}) (说|想)）/g;

/** A body ending mid-token — `（我 ` with the close never arriving — would
 *  visually absorb the text the prefix concatenates after it. */
const TRUNCATED_TAIL_RE = /（\/?[^（）]{0,24}$/;

/** Size past which a single few-shot stops being a few-shot. The real
 *  bound is the prompt budget: the static prefix is cache-stable and paid
 *  for on every completion, so one oversized file is a permanent tax. The
 *  cap is in ESTIMATED TOKENS, not chars — the same content runs ~3× the
 *  chars in the EN corpus, and a char cap silently discriminated by script
 *  (the EN 废案_00 anchor is 27k chars but only ~7k tokens). The largest
 *  seed anchors run ~8.7k estimated tokens; the cap guards against a
 *  runaway file, not against the corpus itself. */
const MAX_BODY_TOKENS = 10_000;

export interface FewShotCheck {
  readonly ok: boolean;
  /** Why it was dropped — logged, never shown to the user. */
  readonly reason?: string;
  /** The sanitized body. Only meaningful when `ok`. */
  readonly body: string;
}

/** Structural fence-balance walk. The grammar is one-deep: a block opens,
 *  its own close ends it, no nesting. Returns null when balanced. */
function fenceImbalance(body: string): string | null {
  let open: { speaker: string; kind: string } | null = null;
  for (const m of body.matchAll(FENCE_RE)) {
    const closing = m[1] === "/";
    const speaker = m[2] as string;
    const kind = m[3] as string;
    if (closing) {
      if (open === null) return `stray close ${m[0]}`;
      if (open.speaker !== speaker || open.kind !== kind) {
        return `close ${m[0]} does not match open （${open.speaker} ${open.kind}）`;
      }
      open = null;
    } else {
      if (open !== null) {
        return `nested open ${m[0]} inside （${open.speaker} ${open.kind}）`;
      }
      open = { speaker, kind };
    }
  }
  if (open !== null) return `unclosed （${open.speaker} ${open.kind}）`;
  return null;
}

/**
 * Sanitize and structurally validate one disk-loaded few-shot body.
 *
 * `stripDisplayUnsafe` runs FIRST and its output is what gets checked, so a
 * fence smuggled through a zero-width or bidi character cannot slip past the
 * scan and then reassemble in the prompt.
 */
export function checkFewShot(name: string, raw: string): FewShotCheck {
  const body = stripDisplayUnsafe(raw);

  if (body.trim().length === 0) {
    return { ok: false, reason: "empty", body };
  }
  const estTokens = estimatePromptTokens(body);
  if (estTokens > MAX_BODY_TOKENS) {
    return {
      ok: false,
      reason: `too long (~${estTokens} > ${MAX_BODY_TOKENS} estimated tokens)`,
      body,
    };
  }
  const imbalance = fenceImbalance(body);
  if (imbalance !== null) {
    return { ok: false, reason: `unbalanced fences: ${imbalance}`, body };
  }
  if (TRUNCATED_TAIL_RE.test(body.trimEnd())) {
    return { ok: false, reason: "truncated fence at end of body", body };
  }
  // The filename filter that used to be the whole gate. Repeated against the
  // CONTENT: a file may be named `### 废案_03：…` and contain anything at all,
  // and the header is what makes the body legible as one of Herta's own
  // discarded drafts rather than free-floating text.
  const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  if (!/^###\s*(废案|记录)/.test(firstLine.trim())) {
    return {
      ok: false,
      reason: `body has no 废案/记录 header (${name})`,
      body,
    };
  }
  return { ok: true, body };
}
