/**
 * Interaction-language selector over the compiled prompt bundles
 * (slice 4). The zh tree (`packages/herta/prompts/**`) and the en tree
 * (`packages/herta/prompts-en/**`) compile into key-parallel constants;
 * this is the single switch every builder goes through so a bundle can
 * never be half-selected. Default stays "zh" at every call site — zh
 * output is byte-identical to pre-slice-4.
 */
import {
  PROMPT_ASSETS,
  PROMPT_ASSETS_EN,
  type PromptAssets,
} from "./prompt-assets.generated.js";
import type { PromptLang } from "./prompt-lang.js";

/** Select the compiled prompt bundle for an interaction language. */
export function promptAssetsFor(lang: PromptLang): PromptAssets {
  return lang === "en" ? PROMPT_ASSETS_EN : PROMPT_ASSETS;
}
