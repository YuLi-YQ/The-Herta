import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * The particle voice catalog: the leading-interjection tokens that have clips
 * (嗯 啊 哦 哎呀 嗯？ …) and the variant clip ids under each. Loaded once from
 * `<voiceRoot>/particle/<token>/NN.wav`. `tokens` is sorted LONGEST-first so the
 * matcher is greedy (哎呀 before 哎, 嗯？ before 嗯). See SPEC 2026-06-23.
 */
export interface ParticleCatalog {
  readonly tokens: readonly string[];
  /** token → its variant clip ids (filename stems, e.g. ["01","02"]). */
  readonly variants: ReadonlyMap<string, readonly string[]>;
}

/** Empty catalog — particles never fire. */
const EMPTY: ParticleCatalog = { tokens: [], variants: new Map() };

/**
 * Read the particle catalog from `particleDir` (`<workspaceRoot>/data/voice/
 * particle`). Each immediate subdirectory is a token; its `*.wav` files are the
 * variants. Best-effort: a missing/unreadable dir → empty catalog (no
 * particles), never throws.
 */
export async function loadParticleCatalog(
  particleDir: string,
): Promise<ParticleCatalog> {
  const variants = new Map<string, readonly string[]>();
  try {
    const entries = await readdir(particleDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const files = await readdir(join(particleDir, entry.name));
        // Opus-only (2026-07-16 cutover): the dev tree keeps .wav masters
        // beside the .opus files; listing both would duplicate every stem.
        const stems = files
          .filter((f) => /\.opus$/i.test(f))
          .map((f) => f.replace(/\.opus$/i, ""))
          .sort();
        if (stems.length > 0) variants.set(entry.name, stems);
      } catch {
        // skip an unreadable token dir
      }
    }
  } catch {
    return EMPTY;
  }
  const tokens = [...variants.keys()].sort((a, b) => b.length - a.length);
  return { tokens, variants };
}

/** Characters that delimit a leading particle (so 嗯 in "嗯哼" is NOT a match). */
const BOUNDARY: ReadonlySet<string> = new Set([
  // CJK clause/sentence punctuation
  "，",
  "。",
  "！",
  "？",
  "、",
  "；",
  "：",
  "…",
  "—",
  // ASCII
  ",",
  ".",
  "!",
  "?",
  ";",
  ":",
  // whitespace
  " ",
  "\n",
  "\t",
  "\r",
]);

/**
 * Boundary-aware longest match of a LEADING particle at the start of `text`,
 * or null. A token matches when `text` starts with it AND either the token is
 * self-delimiting (its last char is a boundary, e.g. the `？`-variants) or the
 * character right after it is a boundary / end-of-string. Greedy: the catalog's
 * tokens are longest-first, so the most specific token wins (哎呀＞哎, 嗯？＞嗯).
 * `嗯，`→嗯, `嗯？x`→嗯？, `哎呀，`→哎呀, `嗯哼`/`xxx，嗯`→null.
 */
export function matchLeadingParticle(
  text: string,
  catalog: ParticleCatalog,
): string | null {
  for (const token of catalog.tokens) {
    if (!text.startsWith(token)) continue;
    const lastChar = token[token.length - 1];
    if (lastChar !== undefined && BOUNDARY.has(lastChar)) return token;
    const after = text[token.length];
    if (after === undefined || BOUNDARY.has(after)) return token;
  }
  return null;
}

/**
 * Pick a random variant clip for `token`, as a voice-cue `{ category, clipId }`
 * (`category` = `particle/<token>`, `clipId` = a variant stem). Returns null for
 * an unknown / variant-less token. `random` is injected for deterministic tests.
 */
export function pickParticleClip(
  catalog: ParticleCatalog,
  token: string,
  random: () => number,
): { readonly category: string; readonly clipId: string } | null {
  const stems = catalog.variants.get(token);
  if (stems === undefined || stems.length === 0) return null;
  const idx = Math.min(stems.length - 1, Math.floor(random() * stems.length));
  const clipId = stems[idx];
  if (clipId === undefined) return null;
  return { category: `particle/${token}`, clipId };
}
