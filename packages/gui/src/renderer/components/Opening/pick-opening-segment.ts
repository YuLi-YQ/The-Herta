import type { SegmentData } from "./ascii-renderer.js";

/** The public application does not mount the legacy opening. Its upstream
 * artwork is excluded; tests can still inject procedural segment loaders. */
const SEGMENT_LOADERS: Record<string, () => Promise<SegmentData>> = {};

/**
 * Pick a random one of the opening segment loaders. `loaders`/`rng` are
 * injectable for tests. An absent catalog rejects through the component's
 * normal asynchronous load-failure path, rather than throwing during mount.
 */
export function pickOpeningSegment(
  loaders: Record<string, () => Promise<SegmentData>> = SEGMENT_LOADERS,
  rng: () => number = Math.random,
): () => Promise<SegmentData> {
  const keys = Object.keys(loaders).sort();
  if (keys.length === 0) {
    return async () => { throw new Error("opening artwork is not distributed in the public build"); };
  }
  const index = Math.min(keys.length - 1, Math.floor(rng() * keys.length));
  return loaders[keys[index] as string] as () => Promise<SegmentData>;
}
