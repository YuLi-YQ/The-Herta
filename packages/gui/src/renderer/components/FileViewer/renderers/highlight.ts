import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import elixir from "highlight.js/lib/languages/elixir";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * The viewer's highlighter (ADR 0054 §4): highlight.js core plus a curated
 * language set — every id `viewer-kind.ts` can name, plus `markdown` for
 * the Markdown SOURCE view. Loaded lazily by the code view (this module
 * is its own chunk), so a plain text file still opens without it.
 */
const LANGUAGES: Readonly<
  Record<string, Parameters<typeof hljs.registerLanguage>[1]>
> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  dart,
  diff,
  dockerfile,
  elixir,
  go,
  graphql,
  ini,
  java,
  javascript,
  json,
  kotlin,
  less,
  lua,
  makefile,
  markdown,
  perl,
  php,
  powershell,
  python,
  r,
  ruby,
  rust,
  scala,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};
for (const [id, def] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(id, def);
}

/** Registered ids, sorted — pinned against `CODE_LANGUAGE_IDS` by test. */
export const REGISTERED_LANGUAGE_IDS: readonly string[] =
  Object.keys(LANGUAGES).sort();

/** Above this the highlighter's cost shows; the code view falls back to
 *  plain text (still with the gutter). */
export const MAX_HIGHLIGHT_CHARS = 300_000;

/** True when `id` (a language id OR a fence alias like `ts`, `sh`) is
 *  something the highlighter knows. */
export function hasLanguage(id: string): boolean {
  return hljs.getLanguage(id) !== undefined;
}

/** highlight.js HTML for `code`, or null when the language is unknown or
 *  the code is too long. The caller sanitizes and adopts it. */
export function highlightToHtml(code: string, language: string): string | null {
  if (code.length > MAX_HIGHLIGHT_CHARS || !hasLanguage(language)) return null;
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
