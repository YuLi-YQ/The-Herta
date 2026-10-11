import { describe, expect, it } from "vitest";
import {
  blankBelow,
  HEADROOM_GAP_PX,
  headroomFor,
  MIN_ROOM_PX,
  MIN_ROOM_RATIO,
  needsRoom,
  preGlideScrollTop,
  releasedExtent,
  targetExtentFor,
} from "./turn-headroom.js";

const VIEW = 800;

/** Scroll geometry as the browser would report it for a given content
 *  bottom and reservation. `scrollHeight` never dips below `clientHeight`
 *  — the clamp that made a fresh session read as "full". */
function geometry(contentBottom: number, spacer: number, viewport = VIEW) {
  const scrollHeight = Math.max(viewport, contentBottom + spacer);
  return { contentBottom, maxScroll: scrollHeight - viewport, viewport };
}

describe("blankBelow", () => {
  it("is what the reservation is still holding open", () => {
    // Long thread, 440px of a reservation not yet consumed by answers.
    expect(blankBelow(geometry(3000, 440))).toBe(440);
  });

  it("is the unused pane when the conversation is too short to scroll", () => {
    expect(blankBelow(geometry(200, 0))).toBe(600);
  });

  it("is zero when the conversation fills the pane and nothing is reserved", () => {
    expect(blankBelow(geometry(3000, 0))).toBe(0);
  });

  it("never goes negative", () => {
    expect(blankBelow(geometry(99_999, 0))).toBe(0);
  });
});

describe("needsRoom", () => {
  it("is true on a full pane with nothing reserved", () => {
    expect(needsRoom(geometry(3000, 0))).toBe(true);
  });

  it("is FALSE while a previous turn's room is still open", () => {
    // The bug this exists to prevent (user 2026-07-29): a short answer left
    // most of its reservation unused, and the next send scrolled the thread
    // up to make room that was already sitting on screen.
    expect(needsRoom(geometry(3000, 440))).toBe(false);
  });

  it("is true when the content runs to the bottom edge — one line of slack is not room", () => {
    // The other end of the same question: "full" has to keep meaning full, or
    // the reservation never fires and replies crawl along the edge again.
    expect(needsRoom(geometry(3000, 0))).toBe(true);
    expect(needsRoom(geometry(3000, 20))).toBe(true);
  });

  it("is false for a conversation that does not fill the pane", () => {
    // The live regression (2026-07-29): taking the content height from
    // `scrollHeight` reported a fresh session as exactly one pane tall, so
    // this read `true` and reserved on the very first message.
    expect(needsRoom(geometry(200, 0))).toBe(false);
    expect(needsRoom(geometry(210, 0, 744))).toBe(false);
  });

  it("turns true again once answers have eaten the room", () => {
    // Just above the line: one reply still fits, so nothing moves.
    expect(needsRoom(geometry(3000, MIN_ROOM_PX + 1))).toBe(false);
    // Just below it: not even one reply fits, make room.
    expect(needsRoom(geometry(3000, MIN_ROOM_PX - 1))).toBe(true);
  });

  it("leaves the page alone whenever there is VISIBLE empty space", () => {
    // The reported bug (user 2026-07-30): the page climbed although a good
    // slab of pane was empty. The old rule was a fraction (0.3) of the pane,
    // which at a windowed 532px called 160px of blank "no room" — measured
    // live as ~2.5 replies' worth — and at 924px called 277px, or 4.3.
    for (const viewport of [532, 744, 924, 1400]) {
      // A couple of replies' worth of blank: never a reason to move.
      expect(needsRoom(geometry(3000, 130, viewport))).toBe(false);
      // What the old rule did with the same geometry, for the record.
      expect(130 < viewport * MIN_ROOM_RATIO).toBe(true);
    }
  });

  it("does NOT scale the threshold with the pane — only caps it", () => {
    // A taller window does not make an answer need more room to begin being
    // read, so the same 100px of blank is "enough" at every real size. The
    // ratio survives only as a cap for absurdly short panes, where an
    // absolute 64px could otherwise exceed a third of the viewport.
    for (const viewport of [480, 744, 1400]) {
      expect(needsRoom(geometry(3000, 100, viewport))).toBe(false);
    }
    // 150px pane: the cap binds (45px), so 50px of blank is still "enough".
    expect(needsRoom(geometry(3000, 50, 150))).toBe(false);
    expect(needsRoom(geometry(3000, 20, 150))).toBe(true);
  });
});

describe("releasedExtent", () => {
  // A 500px blank held open below 3000px of conversation, pane 800.
  const CONTENT = 3000;
  const EXTENT = CONTENT + 500;
  const atBottom = EXTENT - VIEW;

  it("holds while the reader is at the bottom", () => {
    expect(
      releasedExtent({
        extent: EXTENT,
        scrollTop: atBottom,
        viewport: VIEW,
        contentHeight: CONTENT,
      }),
    ).toBe(EXTENT);
  });

  it("spends exactly what was scrolled past", () => {
    // The behaviour asked for: 500px blank, scroll up 100, blank is 400 and
    // there is nothing to scroll back down to.
    const next = releasedExtent({
      extent: EXTENT,
      scrollTop: atBottom - 100,
      viewport: VIEW,
      contentHeight: CONTENT,
    });
    expect(next).toBe(EXTENT - 100);
    // …and the reader is at the new bottom, not 100px above it.
    expect((next ?? 0) - VIEW).toBe(atBottom - 100);
  });

  it("is spent entirely once the reader clears the blank", () => {
    expect(
      releasedExtent({
        extent: EXTENT,
        scrollTop: atBottom - 900,
        viewport: VIEW,
        contentHeight: CONTENT,
      }),
    ).toBeNull();
  });

  it("never grows back on the way down — a one-way ratchet", () => {
    // Eat 100…
    const eaten = releasedExtent({
      extent: EXTENT,
      scrollTop: atBottom - 100,
      viewport: VIEW,
      contentHeight: CONTENT,
    }) as number;
    // …then scroll back down to the (new) bottom and beyond: unchanged.
    for (const scrollTop of [eaten - VIEW - 20, eaten - VIEW, eaten]) {
      expect(
        releasedExtent({
          extent: eaten,
          scrollTop,
          viewport: VIEW,
          contentHeight: CONTENT,
        }),
      ).not.toBe(EXTENT);
    }
    expect(
      releasedExtent({
        extent: eaten,
        scrollTop: eaten - VIEW,
        viewport: VIEW,
        contentHeight: CONTENT,
      }),
    ).toBe(eaten);
  });
});

describe("targetExtentFor + headroomFor", () => {
  const ANCHOR = 3000;
  const CONTENT = ANCHOR + 60; // the bubble you just sent

  it("puts the anchored message HEADROOM_GAP_PX below the top", () => {
    const extent = targetExtentFor({ anchorTop: ANCHOR, viewport: VIEW });
    const spacer = headroomFor({
      targetExtent: extent,
      contentHeight: CONTENT,
    });
    const maxScroll = CONTENT + spacer - VIEW;
    expect(ANCHOR - maxScroll).toBe(HEADROOM_GAP_PX);
  });

  it("holds the extent as the answer grows, so nothing moves", () => {
    const extent = targetExtentFor({ anchorTop: ANCHOR, viewport: VIEW });
    let lastExtent: number | null = null;
    for (const grown of [0, 120, 300, 480]) {
      const content = CONTENT + grown;
      const spacer = headroomFor({
        targetExtent: extent,
        contentHeight: content,
      });
      // Total scrollable extent is identical at every step — which is why a
      // pinned reader's scrollTop, and the anchored message, never move.
      if (lastExtent !== null) expect(content + spacer).toBe(lastExtent);
      lastExtent = content + spacer;
      // …and the message stays exactly where it was put.
      expect(ANCHOR - (content + spacer - VIEW)).toBe(HEADROOM_GAP_PX);
    }
  });

  it("goes inert once the conversation outgrows the extent", () => {
    const extent = targetExtentFor({ anchorTop: ANCHOR, viewport: VIEW });
    expect(
      headroomFor({ targetExtent: extent, contentHeight: extent + 500 }),
    ).toBe(0);
  });

  it("takes no account of the scroller's box model", () => {
    // anchorTop and the extent are both in the scroller's content
    // coordinates, so top padding / --approval-reserve / borders never
    // enter — the same inputs give the same answer whatever the chrome.
    expect(targetExtentFor({ anchorTop: 500, viewport: 800 })).toBe(
      500 - HEADROOM_GAP_PX + 800,
    );
  });
});

describe("preGlideScrollTop", () => {
  it("lands the content's bottom on the viewport's bottom edge", () => {
    // Where a send that reserved nothing would land: the message flush against
    // the bottom, the reserved room still below the fold. The flight aims at
    // the slot as it sits HERE, and the climb happens afterwards.
    expect(preGlideScrollTop({ contentBottom: 3060, viewport: 800 })).toBe(
      2260,
    );
  });

  it("is the reserved bottom MINUS the reservation — that gap is the climb", () => {
    const ANCHOR = 3000;
    const content = ANCHOR + 60;
    const extent = targetExtentFor({ anchorTop: ANCHOR, viewport: VIEW });
    const spacer = headroomFor({
      targetExtent: extent,
      contentHeight: content,
    });
    const parked = preGlideScrollTop({
      contentBottom: content,
      viewport: VIEW,
    });
    expect(extent - VIEW - parked).toBe(spacer);
  });

  it("never asks for a negative scroll on a pane the content cannot fill", () => {
    expect(preGlideScrollTop({ contentBottom: 200, viewport: 800 })).toBe(0);
  });
});
