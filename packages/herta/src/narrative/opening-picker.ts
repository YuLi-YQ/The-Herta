import { promptAssetsFor } from "./prompt-assets.js";
import type { PromptLang } from "./prompt-lang.js";

/**
 * Known time-of-day band tokens recognized by the filename-prefix
 * convention. A file named `NNN-<band>-<rest>.txt` is tagged with the
 * band; files whose second slug segment isn't in this list are tagged
 * `"neutral"` and remain eligible at all hours.
 *
 * `late-night` is a two-token band; the extractor handles it as a
 * single unit. At runtime, both `midnight` and `late-night` files
 * match the night window (22:00–03:59) — they're synonyms in the
 * corpus and `timeBandsAt` returns both tokens for that window.
 */
export type TimeBand =
  | "dawn"
  | "morning"
  | "noon"
  | "afternoon"
  | "evening"
  | "midnight"
  | "late-night";

/** Order matters for `extractBand`: two-token bands MUST appear before
 * single-token bands that are a prefix of them. (Currently only
 * `late-night` is two-token; no single-token band is a prefix of it,
 * so the ordering here is alphabetical for readability.) */
const KNOWN_BANDS: readonly TimeBand[] = [
  "afternoon",
  "dawn",
  "evening",
  "late-night",
  "midnight",
  "morning",
  "noon",
];

export interface OpeningChoice {
  /** Bare-prose preamble (no （X 说） tags). Goes into the model's prompt as session prelude. */
  readonly preamble: string;
  /** Herta's first spoken line. Becomes the seed `herta` block in TerminalRecord. */
  readonly seedText: string;
  /** Source FILENAME (e.g. `016-dawn-first-tea.txt`). Callers derive the
   *  paired voice clipId via `basename(sourceFile, ".txt")` — the stem is
   *  the pairing key, so this stays a filename (not a path) now that the
   *  corpus is compiled in. */
  readonly sourceFile: string;
  /** Time band detected from the filename slug, or `"neutral"`. */
  readonly band: TimeBand | "neutral";
  /** Paired CN voice-clip id (the filename stem). `undefined` when the
   *  opening was picked for an EN session — there are NO English wavs in
   *  v1, and an EN opening must never pair with a CN clip (slice 4).
   *  Callers that play opening voice must key on THIS field, not derive
   *  a clip id from `sourceFile` themselves. */
  readonly voiceClipId?: string;
}

export interface PickOpeningOpts {
  /** Opening corpus, keyed by filename. Defaults to the compiled
   *  `PROMPT_ASSETS.openings` (M-prompts-1, 2026-07-05 — previously read
   *  from the workspace's `.herta/narrative/openings/`, which made the
   *  scene corpus user-editable and empty in any other workspace).
   *  Injected for test determinism. */
  readonly openings?: Readonly<Record<string, string>>;
  /** Defaults to Math.random. Injected for test determinism. */
  readonly rng?: () => number;
  /** Defaults to () => new Date(). Injected for test determinism. */
  readonly clock?: () => Date;
  /** Interaction language: selects the default corpus bundle AND the
   *  voice pairing. `"en"` → openings come from the EN bundle and the
   *  returned `voiceClipId` is `undefined` (no EN wavs in v1); the
   *  filename/time-band logic is language-independent and still applies.
   *  Default "zh" — byte-identical to pre-slice-4 behavior. */
  readonly lang?: PromptLang;
}

/**
 * Pick a random opening from the corpus, filtered by the user's local
 * system time. Returns `undefined` when no eligible opening exists
 * (empty corpus, or all candidates conflict with the current time).
 *
 * Filter rule: keep candidates whose `band === "neutral"` OR whose
 * `band` is in `timeBandsAt(clock().getHours())`. Neutral files are
 * always eligible.
 *
 * Malformed entries are skipped with `console.warn` and don't block
 * selection of valid neighbors.
 *
 * SPEC v0.2 Slice 8 §5.
 */
export function pickOpening(
  opts: PickOpeningOpts = {},
): OpeningChoice | undefined {
  const rng = opts.rng ?? Math.random;
  const clock = opts.clock ?? ((): Date => new Date());
  const lang = opts.lang ?? "zh";
  const openings = opts.openings ?? promptAssetsFor(lang).openings;

  const txts = Object.keys(openings)
    .filter((f) => f.endsWith(".txt"))
    .sort();
  const candidates: OpeningChoice[] = [];
  for (const filename of txts) {
    const content = openings[filename];
    if (content === undefined) continue;
    const parsed = parseOpeningFile(content);
    if ("error" in parsed) {
      console.warn(`pickOpening: skipping ${filename}: ${parsed.error}`);
      continue;
    }
    candidates.push({
      preamble: parsed.preamble,
      seedText: parsed.seedText,
      sourceFile: filename,
      band: extractBand(filename),
      // NO English voice clips in v1: an EN opening carries no pairing.
      ...(lang === "en" ? {} : { voiceClipId: filename.replace(/\.txt$/, "") }),
    });
  }

  if (candidates.length === 0) return undefined;

  const currentBands = timeBandsAt(clock().getHours());
  const filtered = candidates.filter(
    (c) =>
      c.band === "neutral" ||
      (currentBands as readonly string[]).includes(c.band),
  );

  if (filtered.length === 0) return undefined;

  const idx = Math.floor(rng() * filtered.length);
  // Clamp defensively in case rng returns exactly 1.
  const safeIdx = Math.min(idx, filtered.length - 1);
  const choice = filtered[safeIdx];
  if (choice === undefined) return undefined;
  return choice;
}

/**
 * Parse a v0.2 opening file into preamble + seed text.
 *
 * Expected file shape:
 *
 *   [preamble: bare prose, no tags]
 *
 *   （我 说）
 *   [seed line(s)]
 *   （/我 说）
 *
 * Returns `{ preamble, seedText }` on success or `{ error }` on
 * malformed input. The error string is human-readable and is logged
 * via `console.warn` by `pickOpening` so authors can diagnose bad
 * files without crashing the CLI.
 */
export function parseOpeningFile(
  content: string,
): { preamble: string; seedText: string } | { error: string } {
  // Normalize CRLF → LF so the parser works on both Windows and Unix files.
  const trimmed = content.replace(/\r\n/g, "\n").trim();
  const openTag = "\n（我 说）\n";
  const closeTag = "\n（/我 说）";

  const openIdx = trimmed.indexOf(openTag);
  if (openIdx === -1) {
    return { error: "missing or misplaced （我 说） open tag" };
  }
  const seedStart = openIdx + openTag.length;
  const closeIdx = trimmed.indexOf(closeTag, seedStart);
  if (closeIdx === -1) {
    return { error: "missing （/我 说） close tag" };
  }

  const preamble = trimmed.slice(0, openIdx).trim();
  const seedText = trimmed.slice(seedStart, closeIdx).trim();
  const trailing = trimmed.slice(closeIdx + closeTag.length).trim();

  if (preamble.length === 0) return { error: "preamble is empty" };
  if (seedText.length === 0) return { error: "seed text is empty" };
  if (trailing.length !== 0) {
    return {
      error: `unexpected content after （/我 说）: ${trailing.slice(0, 40)}`,
    };
  }

  return { preamble, seedText };
}

/**
 * Extract the time band from a filename slug. Recognizes the
 * `NNN-<band>-<rest>.txt` convention, falls back to `"neutral"`
 * when no known band prefix is found.
 *
 * Examples:
 *   `028-midnight-reboot.txt` → `"midnight"`
 *   `004-late-night-audit.txt` → `"late-night"`
 *   `002-puppet-twitch.txt` → `"neutral"`
 *   `999-morning-after.txt` → `"morning"` (first segment match wins)
 *   `freeform.txt` → `"neutral"` (no NNN- prefix)
 */
export function extractBand(filename: string): TimeBand | "neutral" {
  const stem = filename.replace(/\.txt$/, "").replace(/^\d{3}-/, "");
  for (const band of KNOWN_BANDS) {
    if (stem === band || stem.startsWith(`${band}-`)) {
      return band;
    }
  }
  return "neutral";
}

/**
 * Map a local clock hour (0..23) to the set of valid `TimeBand`
 * tokens for that hour. Neutral files are always added by the picker
 * regardless of this return value.
 *
 * Bands:
 *   04..07 → dawn
 *   08..10 → morning
 *   11..13 → noon
 *   14..17 → afternoon
 *   18..21 → evening
 *   22..03 → midnight + late-night (synonyms in the corpus; both
 *            match the night window)
 */
export function timeBandsAt(hour: number): readonly TimeBand[] {
  if (hour >= 4 && hour < 8) return ["dawn"];
  if (hour >= 8 && hour < 11) return ["morning"];
  if (hour >= 11 && hour < 14) return ["noon"];
  if (hour >= 14 && hour < 18) return ["afternoon"];
  if (hour >= 18 && hour < 22) return ["evening"];
  return ["midnight", "late-night"];
}
