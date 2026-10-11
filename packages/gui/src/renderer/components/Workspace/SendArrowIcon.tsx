/**
 * The send arrow — ONE drawn glyph shared by the real send button and the two
 * morph clones that impersonate it (connect riser, reconnect flyer), so the
 * three can't drift apart. An SVG, not the ↑ text character (owner
 * 2026-08-19, comparing against Codex's button): font metrics rendered the
 * character thin and small inside the 38px circle and varied per font — the
 * exact failure mode the stop square's sized-<span> comment documents.
 * Stroke-based with round caps, matching the paperclip's icon idiom; the
 * container's CSS sizes it (23px in the send button, 18px in the smaller
 * connect-clone circle).
 *
 * Geometry: the owner's pick from the design-gallery playground (2026-08-20
 * — size 23px, stroke 2.1, head 4.0 wide × 4.0 deep), shifted up 0.8 units
 * from the playground's fixed baseline so the ink (stem 3.8–12.4 plus the
 * 1.05-unit round-cap overhang) centres on the 16-unit box — the same
 * ink-vs-box offset the paperclip's viewBox nudge corrects.
 */
export function SendArrowIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 12.4V3.8M4 7.6 8 3.6l4 4" />
    </svg>
  );
}
