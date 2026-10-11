/**
 * Turn headroom — the empty space kept below the conversation so a reply
 * arrives into a region instead of crawling along the bottom edge.
 *
 * Without it, sending on a full pane leaves your message pressed against the
 * composer and the answer fills in one line at a time along the bottom, with
 * the whole conversation shoving upward under it. Reserving the space
 * instead lets the answer be *read* (user 2026-07-29, matching Codex).
 *
 * ## It is a held EXTENT, not a per-frame solve
 *
 * A send that needs room fixes a target scrollable extent — tall enough that
 * scrolling to the bottom puts the message you just sent at the top of the
 * pane — and the spacer is then simply whatever is left of it:
 *
 *     spacer = targetExtent - contentHeight
 *
 * Everything good follows from the extent being HELD. A growing reply eats
 * spacer rather than adding extent, so `scrollHeight` does not change, so a
 * pinned reader's `scrollTop` does not change, so the anchored message does
 * not move by a pixel while the answer fills in beneath it. No per-frame
 * scroll correction, no animation to fight, and no feedback loop: the input
 * (`contentHeight`) excludes the spacer, so the output cannot disturb it.
 *
 * It also needs no scrolling logic of its own. Pin, chip, jump-to-latest and
 * the streaming follow all speak in terms of "the bottom"; moving the bottom
 * moves all of them at once.
 *
 * ## The extent survives the turn that set it
 *
 * The first version re-anchored on every send, and that was wrong (user
 * 2026-07-29): a short answer leaves most of the reservation unused, so the
 * pane still shows a wide blank — and re-anchoring there scrolled the
 * conversation up to make room that was already sitting on screen. Holding
 * the extent instead means the next message simply lands in the blank, no
 * scrolling at all, and the extent is only re-fixed once the answers have
 * actually consumed it. Which is why the question a send asks is
 * {@link needsRoom} — about the blank you can SEE — and not "how long is the
 * history".
 */

/** Breathing room left above the anchored message, so it is near the top
 *  rather than jammed against the edge (the tail of the previous turn stays
 *  faintly visible, which is what makes it read as a continuation). */
export const HEADROOM_GAP_PX = 96;

/**
 * Room enough for an answer to land in: one reply's worth of blank pane.
 * 64px is measured, not chosen — the median (and p90) height of a Herta reply
 * row over the 93 replies of the long fixture, at both a windowed and a
 * maximized window. Below this the answer would start crawling along the
 * bottom edge, which is what the reservation exists to prevent; above it there
 * is somewhere to land and the page must NOT move.
 *
 * This replaced a fraction of the pane (0.3), which was too aggressive by a
 * factor of two and scaled the wrong way (user 2026-07-30: "the page moving up
 * happens when the page is not full filled and have enough space"). Measured
 * live: at a windowed 532px pane it called 160px of visible blank "no room" —
 * 2.5 replies' worth — and at a maximized 924px pane, 277px, or 4.3 replies.
 * A taller window does not make an answer need more room to begin being read,
 * so the threshold is absolute; the pane only enters as the cap below.
 */
export const MIN_ROOM_PX = 64;

/** Cap on {@link MIN_ROOM_PX} as a fraction of the pane, so an absurdly short
 *  pane cannot end up ALWAYS reserving (the threshold would otherwise exceed
 *  the whole viewport). Never binds at real window sizes. */
export const MIN_ROOM_RATIO = 0.3;

/** The blank an answer needs before a send leaves the page alone. */
export function minRoomFor(viewport: number): number {
  return Math.min(MIN_ROOM_PX, viewport * MIN_ROOM_RATIO);
}

/**
 * How much empty pane is visible below the end of the conversation when
 * scrolled to the bottom — the room an answer has to land in *right now*.
 *
 * Covers both ways of having room: a reservation still holding space open,
 * and a conversation too short to fill the pane in the first place. That is
 * why this, rather than any measure of history length, is what a send asks
 * about — the two cases look identical on screen and deserve the same
 * answer.
 *
 * Takes the content's true BOTTOM rather than a height derived from
 * `scrollHeight`, because `scrollHeight` never reports less than
 * `clientHeight`: a nearly-empty conversation reads back as exactly one
 * pane of content and therefore as "full", which is the opposite of the
 * truth (measured live 2026-07-29 — a fresh session reported
 * `content: 744` in a 744px pane). `maxScroll` is safe to take from the
 * browser: the clamp it carries is real, since a pane that cannot scroll
 * genuinely has no scroll to give.
 *
 * @param contentBottom bottom of the real content, in the scroller's own
 *                      content coordinates (i.e. the spacer's top edge)
 * @param maxScroll     `scrollHeight - clientHeight`, as reported
 */
export function blankBelow(args: {
  readonly contentBottom: number;
  readonly maxScroll: number;
  readonly viewport: number;
}): number {
  const contentBottomOnScreen = args.contentBottom - args.maxScroll;
  return Math.max(0, Math.round(args.viewport - contentBottomOnScreen));
}

/**
 * Does the next answer need room made for it? True only when the blank cannot
 * hold even one reply ({@link minRoomFor}) — visible empty space means the
 * page stays put.
 *
 * Latched once per send. Asked continuously, a growing reply would cross the
 * threshold mid-answer and reserve underneath it — a jump, from a decision
 * that belongs to the moment you pressed send.
 *
 * Note the frame this is measured in: the send effect runs after the commit
 * that adds your own message, so `contentBottom` already includes it and the
 * blank is the room left for the ANSWER — a little less than what was on
 * screen when you pressed send, and the right quantity for the question.
 */
export function needsRoom(args: {
  readonly contentBottom: number;
  readonly maxScroll: number;
  readonly viewport: number;
  /** Override the threshold in PX (tests). */
  readonly minRoomPx?: number;
}): boolean {
  return blankBelow(args) < (args.minRoomPx ?? minRoomFor(args.viewport));
}

/**
 * The scrollable extent at which scrolling to the bottom leaves `anchorTop`
 * sitting {@link HEADROOM_GAP_PX} below the top of the pane.
 *
 * At the bottom, `scrollTop` is `extent - viewport`, and the anchor's
 * position on screen is `anchorTop - scrollTop`. Setting that to `gap` and
 * solving gives the line below. Note what is absent: padding, borders, the
 * dynamic `--approval-reserve`. `anchorTop` and the extent are both measured
 * in the scroller's own content coordinates, so its box model never enters.
 */
export function targetExtentFor(args: {
  readonly anchorTop: number;
  readonly viewport: number;
  readonly gap?: number;
}): number {
  return Math.round(
    args.anchorTop - (args.gap ?? HEADROOM_GAP_PX) + args.viewport,
  );
}

/**
 * Where to park the view at the moment of a send, when the travel into the
 * reserved room is going to happen AFTERWARDS.
 *
 * The bottom of the REAL content, i.e. where a send that reserved nothing
 * would land: the message you just sent sits flush against the bottom edge,
 * fully visible, and the room opened below it is not yet on screen. The flying
 * clone therefore has a settled slot to aim at, and the page's climb into the
 * room is a separate move afterwards (user 2026-07-30 — the two used to run
 * together, so the page slid upward while the bubble was still crossing it).
 *
 * @param contentBottom bottom of the real content, in content coordinates
 *                      (i.e. the spacer's top edge)
 */
export function preGlideScrollTop(args: {
  readonly contentBottom: number;
  readonly viewport: number;
}): number {
  return Math.max(0, Math.round(args.contentBottom - args.viewport));
}

/**
 * The extent after a user scroll — reserved room is SLACK, and scrolling up
 * spends it.
 *
 * Left alone, a reservation that an answer never filled sits at the bottom
 * of the pane forever: scroll up to reread, scroll back, and the dead space
 * is still there (user 2026-07-29). Codex releases it as you go — scroll up
 * 100px into a 500px blank and it becomes a 400px blank, with the bottom
 * having come up to meet you, so there is nothing to scroll back down to.
 *
 * A one-way ratchet, and it has to be: room is held for an answer arriving
 * where you are reading, so moving away from it is the signal it is not
 * wanted. Growing back on the way down would make the bottom of the pane
 * chase the reader, which is the opposite of the point.
 *
 * Returns the extent unchanged at (or past) the bottom, and null once the
 * reader has scrolled clear of the blank entirely — from there the content
 * is the only thing holding the scroller open, and normal unpinning takes
 * over.
 */
export function releasedExtent(args: {
  readonly extent: number;
  readonly scrollTop: number;
  readonly viewport: number;
  readonly contentHeight: number;
}): number | null {
  const reachable = args.scrollTop + args.viewport;
  if (reachable >= args.extent) return args.extent;
  if (reachable <= args.contentHeight) return null;
  return Math.round(reachable);
}

/**
 * The spacer height that holds the scroller at `targetExtent`.
 *
 * Clamped at zero: once the conversation has grown past the extent there is
 * nothing left to hold open, and the reservation goes quietly inert — which
 * is where a long thread spends most of its life.
 *
 * @param contentHeight the flow's height EXCLUDING the spacer
 */
export function headroomFor(args: {
  readonly targetExtent: number;
  readonly contentHeight: number;
}): number {
  return Math.max(0, Math.round(args.targetExtent - args.contentHeight));
}
