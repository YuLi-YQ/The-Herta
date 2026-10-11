/**
 * Code-point length of the longest common prefix of `a` and `b`
 * (surrogate-safe — compares `[...str]` elements, not UTF-16 units).
 *
 * The actor computes the supervisor-veto divergence with this so the GUI's
 * retract morph can halt its backward erase exactly at the first character
 * the re-speak changes (the `retractFloor` control event). Mirrors the GUI's
 * own `commonPrefixLen` in `useRetractMorph.ts`; kept package-local (do not
 * import across the app-server boundary).
 */
export function commonPrefixLen(a: string, b: string): number {
  const ca = [...a];
  const cb = [...b];
  const max = Math.min(ca.length, cb.length);
  let i = 0;
  while (i < max && ca[i] === cb[i]) i += 1;
  return i;
}
