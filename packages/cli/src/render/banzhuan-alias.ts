/**
 * 板砖 → Brick display/input aliasing for the CLI (ADR 0015) — thin re-export
 * of the shared implementation in @herta/core (core/src/text/banzhuan-alias.ts),
 * which single-sources the helpers this file, the GUI renderer, and the GUI
 * main process previously kept as hand-synced lockstep copies. DISPLAY/INPUT
 * layer only: the wire token `@板砖` and the persisted record keep 板砖 (D2).
 * The lang argument at every call site is @herta/herta's PromptLang — the
 * same `"zh" | "en"` union the shared module declares.
 */
export {
  aliasBanzhuanDisplay,
  aliasBanzhuanPlain,
  aliasBrickInput,
} from "@herta/core/banzhuan-alias";
