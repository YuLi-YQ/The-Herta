import type { SegmentData } from "./ascii-renderer.js";

/**
 * Lazy importers for the 8 committed opening segment assets. Vite code-splits
 * each entry, so only the chosen segment is fetched at runtime (`{ import:
 * "default" }` resolves to the parsed JSON object).
 */
const SEGMENT_LOADERS = import.meta.glob<SegmentData>(
  "../../assets/openings/*.json",
  { import: "default" },
) as Record<string, () => Promise<SegmentData>>;

/**
 * Pick a random one of the opening segment loaders. `loaders`/`rng` are
 * injectable for tests; production uses the real glob + Math.random.
 */
export function pickOpeningSegment(
  loaders: Record<string, () => Promise<SegmentData>> = SEGMENT_LOADERS,
  rng: () => number = Math.random,
): () => Promise<SegmentData> {
  const keys = Object.keys(loaders).sort();
  if (keys.length === 0) {
    throw new Error("no opening segment assets found");
  }
  const index = Math.min(keys.length - 1, Math.floor(rng() * keys.length));
  return loaders[keys[index] as string] as () => Promise<SegmentData>;
}
