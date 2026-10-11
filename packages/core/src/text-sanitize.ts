/**
 * Unicode display hygiene shared by the commit boundary (@herta/herta's
 * `sanitizeActorText`) and the render boundary (GUI bubbles, session
 * titles). Pure string code with NO node imports — the GUI renderer
 * imports it via the `@herta/core/text-sanitize` subpath so the browser
 * bundle never touches the node-only modules the package root re-exports.
 *
 * What is stripped, and why. The set is a SUPERSET of the invisibles in
 * validateFeian's BAD_RANGES (the 2026-07-09 review found the two had
 * diverged: the dream gate rejected the Tag block / word joiner / C1 /
 * line separators while this strip — the guard on the record/prompt
 * path, which every turn crosses — let them through):
 *   - C0 control chars except `\n`/`\t`, plus DEL and the C1 block
 *     (U+007F-U+009F): removes the ESC/OSC/CSI introducers of ANSI
 *     escape sequences at the source — including the one-char C1 forms
 *     CSI U+009B / OSC U+009D — so model output can never
 *     style/overwrite a TTY or smuggle terminal control through the
 *     record. `\r` goes too (CRLF normalizes to LF).
 *   - Bidi overrides & isolates (U+202A-U+202E, U+2066-U+2069) plus the
 *     invisible directional marks LRM/RLM (U+200E-U+200F): an RLO in
 *     model text visually reverses everything after it — classic display
 *     spoofing (e.g. making "evil.ts deleted" read as "deleted st.live").
 *   - Line/paragraph separators (U+2028-U+2029): render as line breaks
 *     without being `\n`, so line-based scanning and the visual surface
 *     disagree about where a line starts.
 *   - Zero-width: ZWSP (U+200B), ZWNJ (U+200C), BOM/ZWNBSP (U+FEFF),
 *     and word joiner + invisible operators (U+2060-U+2064) —
 *     invisible characters that defeat literal-substring scanners and
 *     let visually-identical strings differ. WJ U+2060 is FEFF's
 *     designated successor; leaving it in replayed the ZWSP-in-marker
 *     smuggle one codepoint over (a marker with a WJ inside is not a
 *     literal match, so the escape layer's break pass no-opped on it).
 *     ZWJ (U+200D) is deliberately PRESERVED: stripping it would break
 *     legitimate emoji sequences (three code points joined by ZWJ
 *     render as one family emoji).
 *   - Lone surrogates (U+D800-U+DFFF): ill-formed text that downstream
 *     encoders mangle. The `u` flag makes the class match ONLY unpaired
 *     halves — a valid pair is one astral code point and never matches.
 *   - Unicode Tag block (U+E0000-U+E007F): invisibly re-encodes ASCII —
 *     a hidden-instruction channel into the prompt (same reasoning as
 *     the dream gate's reject). Deliberate trade-off: emoji tag
 *     sequences (the England/Scotland/Wales flags) lose their tag chars
 *     and fall back to the base black flag — acceptable here.
 *
 * Ordering contract with the marker-escaping in @herta/herta/escape.ts:
 * that module inserts ZWSP as its neutralization separator, so it must
 * run this strip FIRST and insert its ZWSPs after — never the reverse.
 *
 * The character class is written with escape sequences so the source
 * file itself stays printable ASCII (a raw NUL in a literal makes git
 * and some editors treat the file as binary).
 */
const DISPLAY_UNSAFE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is this module's purpose
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B\u200C\u200E\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uD800-\uDFFF\uFEFF\u{E0000}-\u{E007F}]/gu;

/** Remove control, bidi-override, and zero-width characters (see module
 *  doc for the exact set and the ZWJ carve-out). Identity for normal
 *  prose, CJK, and emoji — safe to apply per render. */
export function stripDisplayUnsafe(text: string): string {
  return text.replace(DISPLAY_UNSAFE, "");
}
