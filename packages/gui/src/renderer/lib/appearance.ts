export type Appearance = "observatory";

/** R133: one visual system for both workspaces. Older localStorage values no
 * longer select a separate UI; no stored theme, font or motion setting changes. */
export function appearance(): Appearance {
  return "observatory";
}

export function initializeAppearance() {
  document.documentElement.dataset.appearance = appearance();
}
