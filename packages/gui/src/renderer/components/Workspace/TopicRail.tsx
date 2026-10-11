import type { SessionTopic } from "@herta/app-server";
import {
  memo,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FLIP_MS, useFlipList } from "../../hooks/useFlipList.js";
import { usePresence } from "../../hooks/usePresence.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { useT } from "../../i18n/LocaleProvider.js";
import {
  aliasBanzhuanPlain,
  stripInlineCodeTicks,
} from "../../lib/banzhuan-mention.js";

/** Ticks in the rail's WINDOW. The rail is a spatial guide, not an index:
 *  it shows where you are and what is just around you, and the window slides
 *  with the reading position rather than folding open (2026-07-27). */
export const RAIL_MAX_TOPICS = 12;

/**
 * Index of the topic whose region contains `recordIndex`, or -1 when it sits
 * before the first topic. Topics are in record order, so the scan can stop at
 * the first anchor past the target.
 */
export function topicIndexAt(
  topics: readonly SessionTopic[],
  recordIndex: number,
): number {
  let found = -1;
  for (let f = 0; f < topics.length; f += 1) {
    const anchor = topics[f]?.anchorIndex;
    if (anchor === undefined || anchor > recordIndex) break;
    found = f;
  }
  return found;
}

/**
 * The window of topic indices to render: `size` ticks centred on `current`,
 * clamped to both ends.
 *
 * Centred so a jump backward shows what lies AHEAD of the landing point as
 * well as behind it; clamped so that at either end it degrades to exactly the
 * old layout — at the bottom (the streaming case, and the default when no
 * reading position is known) that is the latest `size` topics, unchanged.
 */
export function railWindowStart(args: {
  readonly total: number;
  readonly size: number;
  readonly current: number;
}): number {
  const { total, size, current } = args;
  if (total <= size) return 0;
  const centred = current - Math.floor((size - 1) / 2);
  return Math.max(0, Math.min(total - size, centred));
}

/** Tick geometry: base line width, the hovered tick's extra width, and how
 *  many neighbors the dock-style magnification reaches. A neighbor at index
 *  distance d gets `extra × (1 − d / FALLOFF_RADIUS)` (linear falloff to 0),
 *  so the hovered line grows most and the swell decays outward. The widths
 *  are plain inline styles behind a CSS width transition — moving the cursor
 *  re-targets them and LEAVING resets them to base, so the same transition
 *  plays the swell in reverse on the way out. */
const TICK_BASE_W = 14;
const TICK_MAX_EXTRA = 14;
const FALLOFF_RADIUS = 3;

interface HoverState {
  /** Index into the SHOWN topics — the swell is pure geometry, so it keys on
   *  the position under the cursor. */
  readonly i: number;
  /** The hovered tick's top offset within the rail — measured at hover time
   *  rather than derived from the index, so it stays correct as the window
   *  slides under the cursor. */
  readonly top: number;
  /** The topic itself, snapshotted when the hover event fired. The card
   *  renders THIS, not `shown[i]`: the window can slide under a stationary
   *  cursor (a topic lands while streaming; the recentre after a tick
   *  click), and re-deriving from the position flipped the card to whatever
   *  topic slid into it — mid-hover, and worse, mid-exit-fade, when there is
   *  no cursor for the content to be "under" at all (2026-07-30). When the
   *  slide is real the ticks REMOUNT (keyed by topicKey), Chromium
   *  re-dispatches the boundary events for the new node under the cursor,
   *  and the snapshot refreshes at the moment hover actually changes —
   *  event-driven, not render-math-driven. */
  readonly topic: SessionTopic;
}

/** Row identity — React key, FLIP key, and the hover-blur compare.
 *  `anchorIndex` alone is NOT unique: a re-entry retitle windows back over
 *  an earlier exchange, so its fresh topic legitimately shares the old
 *  topic's anchor (the app-server's re-entry test pins exactly that
 *  geometry — and that pair is what makes the rail visible at all in a
 *  1-topic session). Keyed on the anchor alone, React reported duplicate
 *  keys and mis-reconciled window slides, and useFlipList's rect map kept
 *  only the second twin — the first glided from the wrong origin (review
 *  2026-07-31). `bornAtLength` is exactly what separates the pair (how much
 *  conversation each needed to exist); legacy pre-2026-07-30 entries fall
 *  back to their creation stamp. */
function topicKey(t: SessionTopic): string {
  return `${t.anchorIndex}:${t.bornAtLength ?? t.at}`;
}

/** The tick's top offset within the rail, for positioning the card beside
 *  it. Shared by mouse hover and keyboard focus. */
function tickTop(el: HTMLElement): number {
  const nav = el.closest(".topic-rail");
  return nav === null
    ? 0
    : el.getBoundingClientRect().top - nav.getBoundingClientRect().top;
}

export interface TopicRailProps {
  /** Full topic history. The rail renders a RAIL_MAX_TOPICS window of it,
   *  positioned by the reader's place in the conversation. */
  readonly topics: readonly SessionTopic[];
  /** Session interaction language: the card shows RECORD text (title +
   *  anchoring user message), so it carries the 板砖→Brick display alias
   *  keyed on the session, like the bubbles (ADR 0015). */
  readonly lang: "zh" | "en";
  /** Jump to a topic's anchoring block (absolute record index). */
  readonly onJump: (anchorIndex: number) => void;
  /** The conversation's scroll container. When provided, the rail tracks
   *  which topic region(s) the viewport currently shows and inks those
   *  ticks (Codex-style scrollspy, user 2026-07-14). Optional — the demo
   *  and short-lived fakes render fine without it. */
  readonly scrollerRef?: RefObject<HTMLElement | null>;
}

/** The record-index span the viewport currently shows, measured from the
 *  scroller's `[data-abs-index]` rows (user rows, in record order):
 *  `lo` = the last row starting at/above the viewport top (its region
 *  contains the first visible pixel), `hi` = the last row starting above
 *  the viewport bottom. A viewport-top above every loaded row falls back
 *  to just-before the first loaded row — the containing region is older
 *  than the loaded window, so only its topic (if any) can claim it. */
function visibleSpan(scroller: HTMLElement): readonly [number, number] | null {
  const v = scroller.getBoundingClientRect();
  const rows = scroller.querySelectorAll<HTMLElement>("[data-abs-index]");
  if (rows.length === 0) return null; // no user rows loaded
  // BINARY search, not a scan of every row (perf 2026-07-30). This runs once
  // per rAF for the whole life of any scroll — including under the send
  // animations, which is where the user saw frames drop — and the linear
  // version read a rect per row: 108 forced-layout reads per frame on the
  // 240-block fixture, against ~7 now. Rows are stacked in flow order, so
  // their tops ascend with DOM order and the boundary is searchable; the
  // worst a violated assumption can do is ink a neighbouring tick, the same
  // tolerance the search-index scan documents.
  const topOf = (i: number): number =>
    (rows[i] as HTMLElement).getBoundingClientRect().top;
  /** Index of the last row starting at or above `edge`, or -1. */
  const lastAtOrAbove = (edge: number, orEqual: boolean): number => {
    let found = -1;
    let lo = 0;
    let hi = rows.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = topOf(mid);
      if (orEqual ? t <= edge : t < edge) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };
  const idxAt = (i: number): number => Number(rows[i]?.dataset.absIndex);
  const first = idxAt(0);
  if (!Number.isFinite(first)) return null;
  const loRow = lastAtOrAbove(v.top, true);
  const hiRow = lastAtOrAbove(v.bottom, false);
  // A viewport-top above every loaded row falls back to just-before the first
  // loaded row — the containing region is older than the loaded window, so
  // only its topic (if any) can claim it.
  const lo = loRow === -1 ? first - 0.5 : idxAt(loRow);
  const hi = hiRow === -1 ? lo : idxAt(hiRow);
  return [lo, hi];
}

/**
 * Topic guide rail (2026-07-12): a slim column of horizontal ticks — one per
 * topic — hugging the conversation's left edge. Hovering a tick swells it
 * (and, with falloff, its neighbors) and raises a card with the topic's
 * generated title + its anchoring user message; clicking jumps to that spot
 * in the history. Labels come from the retitle mechanism's history, so the
 * rail costs no extra model calls. Hidden below two topics — no chrome for
 * short sessions.
 *
 * Beyond RAIL_MAX_TOPICS the rail WINDOWS rather than folding: it shows the
 * ticks around the reading position, fading whichever end still hides
 * history, and slides as the reader scrolls or jumps. See the window block in
 * the body for why the ⋯ fold went away.
 */
// memo: Conversation re-renders per streaming delta (~12-30/s) and per
// record block, and every prop here is identity-stable across those renders
// (`topics` ref, `lang`, a useCallback `onJump`, the ref object) — so the
// rail bails out of the whole jank window instead of reconciling 12 buttons
// per delta (perf review 2026-07-31).
export const TopicRail = memo(function TopicRail(
  props: TopicRailProps,
): JSX.Element | null {
  const t = useT();
  const [hovered, setHovered] = useState<HoverState | null>(null);
  // The card content must survive its own exit animation (hovered goes null
  // while the card fades) — keep the last hover for it. Null only before the
  // first hover, and the card cannot be mounted then.
  const lastHoveredRef = useRef<HoverState | null>(null);
  if (hovered !== null) lastHoveredRef.current = hovered;
  const card = usePresence(hovered !== null, 200);

  // ── Scrollspy (user 2026-07-14) ──────────────────────────────────────────
  // Track the record-index span the viewport shows and ink the tick(s) whose
  // topic region intersects it — a reading position the rail shows without
  // being hovered. rAF-throttled; a hidden window just parks the pending
  // frame until it is visible again (cosmetic state — nothing waits on it).
  const [span, setSpan] = useState<readonly [number, number] | null>(null);
  const scrollerRef = props.scrollerRef;
  useEffect(() => {
    const scroller = scrollerRef?.current ?? null;
    if (scroller === null) return;
    let raf = 0;
    const measure = (): void => {
      raf = 0;
      const next = visibleSpan(scroller);
      setSpan((prev) =>
        prev !== null &&
        next !== null &&
        prev[0] === next[0] &&
        prev[1] === next[1]
          ? prev
          : next,
      );
    };
    const onScroll = (): void => {
      if (raf === 0) raf = requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
    // The span is pure DOM measurement (record indices); topic changes only
    // re-partition the REGIONS, which the render-time mapping picks up.
  }, [scrollerRef]);

  // ── The window (2026-07-27) ──────────────────────────────────────────────
  // The rail used to render `topics.slice(-RAIL_MAX_TOPICS)` unconditionally,
  // with a ⋯ fold opening the full history in an inner scroller. Two things
  // were wrong with that. The window and the scrollspy DISAGREED: the ink
  // tested the viewport against every topic while only the last 12 could ever
  // be on screen, so scrolling back beyond them inked nothing at all — the
  // rail stopped reporting a position exactly when the reader was most lost.
  // And the fold's "complete access" was thin: every tick is an unlabelled
  // line, so 100 of them in a scroller is a haystack, not an index (the
  // sidebar's content search, which shows real titles, is the honest answer
  // for distant navigation).
  //
  // Now the window slides with the reading position and both derive from the
  // SAME measurement, so they cannot disagree. Clicking a tick jumps the
  // conversation, which moves `span`, which moves the window — the rail
  // follows a backward jump with no extra wiring.
  //
  // (Above the short-session early return because the FLIP hooks below need
  // the window; all plain math, safe on 0 or 1 topics.)
  const total = props.topics.length;
  const size = Math.min(RAIL_MAX_TOPICS, total);
  // No measured position (no scroller, pre-measure, or a viewport above the
  // first topic) → the latest, which is where a streaming reader is.
  const currentIndex =
    span === null
      ? total - 1
      : Math.max(0, topicIndexAt(props.topics, span[0]));
  const start = railWindowStart({ total, size, current: currentIndex });
  // Memoized for the FLIP effect below, which keys on the window's IDENTITY:
  // rebuilt inline, every span change (every scroll frame) would re-run the
  // measure — a forced getBoundingClientRect per tick plus a finish() that
  // snaps in-flight glides dead (the same trap Sidebar.tsx documents).
  const shown = useMemo(
    () => props.topics.slice(start, start + size),
    [props.topics, start, size],
  );

  // ── The slide is ANIMATED (user 2026-07-30) ─────────────────────────────
  // A boundary crossing re-maps every tick to a neighbouring topic at once;
  // rendered plainly that is a teleport — each line's meaning changes with
  // nothing moving. The FLIP glide keeps each surviving topic's tick a
  // CONTINUOUS object: it slides one pitch up or down to its new slot, so
  // the eye tracks "the strip moved" instead of re-reading the mapping.
  // Enters/leaves pop, but only under the 28px end fades, where a tick is
  // already nearly invisible. Same hook as the sidebar's reorder glide —
  // including its masked-container stale-raster heal, which this list (also
  // CSS-masked) needs for the same reason.
  const listRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  // topicKey, matching the DOM's data-flip-key (339fb40) — keyed on the
  // anchor alone, re-entry twins collapsed to one signature entry and a
  // slide exchanging them read as "no order change".
  const flipKeys = useMemo(() => shown.map(topicKey), [shown]);
  useFlipList(listRef, flipKeys, reduced);

  // A hover landed mid-glide stamps the card's `top` from a rect still
  // carrying the slide's translateY — up to one pitch off, and nothing
  // corrected it (the card's `top` transition only softened the error).
  // Re-stamp the hovered tick once the glide has landed (deferred-fix
  // 2026-07-31). Armed on every hover/slide change; the same-key guard
  // leaves a hover that moved on untouched, and an unchanged top returns
  // the same state (no render).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `start` is the slide trigger — a window that slid under a held hover must re-arm the re-stamp
  useEffect(() => {
    if (hovered === null) return;
    const container = listRef.current;
    if (container === null) return;
    const key = topicKey(hovered.topic);
    const id = window.setTimeout(() => {
      for (const el of container.querySelectorAll<HTMLElement>(
        "[data-flip-key]",
      )) {
        if (el.dataset.flipKey !== key) continue;
        const top = tickTop(el);
        setHovered((h) =>
          h !== null && topicKey(h.topic) === key && h.top !== top
            ? { ...h, top }
            : h,
        );
        return;
      }
    }, FLIP_MS + 40);
    return () => window.clearTimeout(id);
  }, [hovered, start]);

  if (props.topics.length < 2) return null;
  // Fade whichever end still hides history. BOTH matter: after a jump back
  // there is hidden history below too, and a top-only fade would imply the
  // bottom tick is still the latest — the very thing the jump just changed.
  const fadeTop = start > 0;
  const fadeBottom = start + size < total;

  // Topic f's region spans [anchor_f, anchor_{f+1}) in record indices; its
  // tick is "current" when that region intersects the visible span. A
  // viewport straddling a boundary inks both ticks.
  const offset = start;
  const isCurrent = (i: number): boolean => {
    if (span === null) return false;
    const f = i + offset;
    const anchor = props.topics[f]?.anchorIndex;
    if (anchor === undefined) return false;
    const nextAnchor =
      props.topics[f + 1]?.anchorIndex ?? Number.POSITIVE_INFINITY;
    return anchor <= span[1] && nextAnchor > span[0];
  };

  const width = (i: number): number => {
    if (hovered === null) return TICK_BASE_W;
    const d = Math.abs(i - hovered.i);
    return TICK_BASE_W + TICK_MAX_EXTRA * Math.max(0, 1 - d / FALLOFF_RADIUS);
  };
  // The card renders the SNAPSHOT, never `shown[last.i]` — see HoverState.
  const last = lastHoveredRef.current;

  return (
    <nav
      className="topic-rail"
      aria-label={t("workspace.topicRailAria")}
      onMouseLeave={() => setHovered(null)}
    >
      <div
        ref={listRef}
        className={`topic-rail__list${fadeTop ? " has-fade-top" : ""}${
          fadeBottom ? " has-fade-bottom" : ""
        }`}
      >
        {shown.map((topic, i) => (
          <button
            key={topicKey(topic)}
            data-flip-key={topicKey(topic)}
            type="button"
            className={`topic-rail__tick${isCurrent(i) ? " is-current" : ""}`}
            aria-current={isCurrent(i) ? "true" : undefined}
            aria-label={topic.title}
            onMouseEnter={(e) =>
              setHovered({ i, top: tickTop(e.currentTarget), topic })
            }
            onFocus={(e) =>
              // Same measurement as the mouse path — the card sits beside
              // the focused tick rather than parking at the rail's top.
              setHovered({ i, top: tickTop(e.currentTarget), topic })
            }
            onBlur={() =>
              // By identity, not position: if the window slid between focus
              // and blur, the position may name a different topic by now.
              // topicKey, not anchorIndex — re-entry twins share an anchor.
              setHovered((h) =>
                h !== null && topicKey(h.topic) === topicKey(topic) ? null : h,
              )
            }
            onClick={() => props.onJump(topic.anchorIndex)}
          >
            <span
              className="topic-rail__line"
              style={{ width: `${width(i)}px` }}
            />
          </button>
        ))}
      </div>
      {card.mounted && last !== null && (
        <div
          className={`topic-rail__card${card.open ? " is-open" : ""}`}
          style={{ top: `${last.top}px` }}
        >
          {/* stripInlineCodeTicks: too small for a code chip, so a backticked
              identifier shows its inside rather than its delimiters. */}
          <p className="topic-rail__card-title">
            {stripInlineCodeTicks(
              aliasBanzhuanPlain(last.topic.title, props.lang),
            )}
          </p>
          <p className="topic-rail__card-preview">
            {stripInlineCodeTicks(
              aliasBanzhuanPlain(last.topic.anchorText, props.lang),
            )}
          </p>
        </div>
      )}
    </nav>
  );
});
