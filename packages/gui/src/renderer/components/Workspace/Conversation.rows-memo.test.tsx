import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { Conversation } from "./Conversation.js";
import { WorkspaceRefsProvider } from "./WorkspaceRefs.js";

/**
 * Counting passthrough over the timestamp formatter. It is the honest probe
 * for "did the row work run": `formatBubbleTime` runs once per timestamped
 * block's BubbleTime leaf (as of perf 2026-08-25; previously per
 * `renderBlock`), so its call count still tracks bubble-row render work —
 * and it was the top app-level cost in the send profile.
 *
 * Its own suite covers the formatting; this file only counts.
 */
const calls = { formatBubbleTime: 0, segmentSpeech: 0, activityChipLabel: 0 };
vi.mock("./format-time.js", async () => {
  const real =
    await vi.importActual<typeof import("./format-time.js")>(
      "./format-time.js",
    );
  return {
    ...real,
    formatBubbleTime: (...args: Parameters<typeof real.formatBubbleTime>) => {
      calls.formatBubbleTime += 1;
      return real.formatBubbleTime(...args);
    },
  };
});
// The same passthrough trick over the Herta bubble's segmenter: it runs in
// HertaBubble's own render body, so its call count IS the number of Herta
// bubble BODIES rendered — distinguishing "the row re-rendered" from "only
// its BubbleTime leaf re-derived a label" (perf 2026-08-25).
vi.mock("../../lib/segment-speech.js", async () => {
  const real = await vi.importActual<
    typeof import("../../lib/segment-speech.js")
  >("../../lib/segment-speech.js");
  return {
    ...real,
    segmentSpeech: (...args: Parameters<typeof real.segmentSpeech>) => {
      calls.segmentSpeech += 1;
      return real.segmentSpeech(...args);
    },
  };
});

// And over the activity group's chip label: it is computed inside
// ActivityBlock's `derived` memo, which keys on the `blocks` ARRAY — so its
// call count IS the number of groups that re-derived their rows, patches and
// headline (ADR 0068 §8).
vi.mock("./group-record.js", async () => {
  const real =
    await vi.importActual<typeof import("./group-record.js")>(
      "./group-record.js",
    );
  return {
    ...real,
    activityChipLabel: (...args: Parameters<typeof real.activityChipLabel>) => {
      calls.activityChipLabel += 1;
      return real.activityChipLabel(...args);
    },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  calls.formatBubbleTime = 0;
  calls.segmentSpeech = 0;
  calls.activityChipLabel = 0;
});

/** A record of `pairs` exchanges, every block timestamped so each one costs a
 *  formatter call. */
function longRecord(pairs: number) {
  const at = new Date("2026-07-30T04:00:00.000Z").toISOString();
  return Array.from({ length: pairs }, (_, i) => [
    { kind: "user" as const, text: `question ${i}`, at },
    {
      kind: "herta" as const,
      surface: "speech" as const,
      text: `answer ${i}`,
      at,
    },
  ]).flat();
}

function mount(pairs: number) {
  const mock = createMockHertaBridge();
  const view = renderWithLocale(
    <WorkspaceRefsProvider>
      <HertaBridgeProvider bridge={mock.bridge}>
        <Conversation />
      </HertaBridgeProvider>
    </WorkspaceRefsProvider>,
  );
  act(() => {
    mock.emitReset({
      sessionId: "perf-session",
      workspaceRoot: "/r",
      record: longRecord(pairs),
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
  });
  return { mock, view };
}

describe("Conversation — the row memo does not depend on turn state (2026-07-30)", () => {
  it("a send re-renders NO bubble rows", () => {
    // The bug: `rows` was one memo over both bubble and activity rows, so it
    // carried the activity groups' dependencies — status, turnStartedAt,
    // backendStartedAt, backendInFlight, backendActive, plan, canRewind. All of
    // those flip when a turn starts, so pressing send re-rendered every bubble
    // in the session (and again when the turn ended) — 40 rows here, ~100 in a
    // real long session, each one an Intl format, landing exactly on the send
    // animation's first frames.
    const { mock } = mount(20);
    expect(calls.formatBubbleTime).toBeGreaterThan(0); // the initial render
    const afterMount = calls.formatBubbleTime;

    // Turn starts: status idle → thinking, turnStartedAt set.
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    expect(calls.formatBubbleTime).toBe(afterMount);

    // …and the backend goes to work: backendStartedAt / backendActive /
    // inFlight all move.
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "turn.started",
          layer: "backend",
          userText: "",
        } as never,
      });
    });
    expect(calls.formatBubbleTime).toBe(afterMount);

    // …and the turn ends, which flips status back and clears the anchors.
    act(() => {
      mock.emitTurn({ kind: "finished", turnId: "t1" });
    });
    expect(calls.formatBubbleTime).toBe(afterMount);
  });

  it("but a new block DOES render rows — the memo is not simply frozen", () => {
    // Without this the test above would pass just as well on a memo that never
    // recomputes, which would be a rendering bug rather than a fix.
    const { mock } = mount(20);
    const afterMount = calls.formatBubbleTime;
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "extra",
        block: {
          kind: "user",
          text: "one more",
          at: new Date("2026-07-30T04:10:00.000Z").toISOString(),
        },
      });
    });
    expect(calls.formatBubbleTime).toBeGreaterThan(afterMount);
    expect(screen.getByText("one more")).toBeInTheDocument();
  });

  it("the rewind control is hidden mid-turn, and back when the turn ends", () => {
    // The gate moved from a withheld prop (which is what put `status` in the
    // memo) to CSS plus the handler's own idle check. The affordance must still
    // come and go with the turn.
    const { mock, view } = mount(2);
    const flow = view.container.querySelector(
      ".conversation-flow",
    ) as HTMLElement;
    expect(view.container.querySelector(".message-rewind")).not.toBeNull();
    expect(flow.classList.contains("is-busy")).toBe(false);
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    // Still mounted (the row did not re-render) but not offered: the rule that
    // hides it keys on this class.
    expect(flow.classList.contains("is-busy")).toBe(true);
    act(() => {
      mock.emitTurn({ kind: "finished", turnId: "t1" });
    });
    expect(flow.classList.contains("is-busy")).toBe(false);
  });

  it("a 30s clock tick re-renders label leafs, never bubble bodies (perf 2026-08-25)", () => {
    // The bug: `now` (a 30s ticking useNow state) sat in the blockRows memo
    // deps, so every tick rebuilt and reconciled every mounted row element —
    // and a row whose label string DID change re-rendered its whole bubble.
    // The clock now lives in lib/now-tick, subscribed per-label in the
    // BubbleTime leaf: a tick re-derives strings, and only a leaf whose
    // string changed re-renders. The probe: `segmentSpeech` runs in
    // HertaBubble's render body, so a stable count across a label change
    // proves the bubble body stayed out of it.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
    const young = new Date("2026-07-30T11:59:40.000Z").toISOString(); // 20s old
    const old = new Date("2026-07-30T09:00:00.000Z").toISOString(); // same day
    const mock = createMockHertaBridge();
    const view = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "tick-session",
        workspaceRoot: "/r",
        record: [
          { kind: "user", text: "old question", at: old },
          { kind: "herta", surface: "speech", text: "old answer", at: old },
          { kind: "user", text: "young question", at: young },
          { kind: "herta", surface: "speech", text: "young answer", at: young },
        ],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const labels = (): (string | null)[] =>
      Array.from(view.container.querySelectorAll(".message-actions__time")).map(
        (el) => el.textContent,
      );
    const atMount = labels();
    expect(atMount.slice(2)).toEqual(["just now", "just now"]);
    const segsAfterMount = calls.segmentSpeech;
    expect(segsAfterMount).toBeGreaterThan(0);
    // Tick 1 (+30s → the young blocks are 50s old): no label crosses a
    // boundary, nothing re-renders.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(labels()).toEqual(atMount);
    expect(calls.segmentSpeech).toBe(segsAfterMount);
    // Tick 2 (+60s → 80s old): the young labels cross the minute boundary…
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(labels().slice(2)).toEqual(["1 min ago", "1 min ago"]);
    // …the same-day rows' time-of-day labels hold steady…
    expect(labels().slice(0, 2)).toEqual(atMount.slice(0, 2));
    // …and NO bubble body re-rendered for it: only the changed labels'
    // BubbleTime leafs did. Pre-fix, the fresh label string flowed in as a
    // bubble prop, broke the memo, and re-segmented the young reply here.
    expect(calls.segmentSpeech).toBe(segsAfterMount);
  });

  it("a new record block re-derives ONE activity group, not every group in the window (ADR 0068 §8)", () => {
    // The bug: groupRecord rebuilt every group's `blocks` array per commit,
    // memo(ActivityBlock) compares by identity, so one block at the tail
    // re-rendered — and re-derived rows, patches, headline for — every
    // historical group. 12 groups here; a long session holds 20–40, and a
    // parallel tool batch is five to ten commits in a row.
    const GROUPS = 12;
    const at = new Date("2026-07-30T04:00:00.000Z").toISOString();
    const record = Array.from({ length: GROUPS }, (_, i) => [
      { kind: "user" as const, text: `task ${i}`, at },
      {
        kind: "system" as const,
        label: "差分协处理器" as const,
        body: `Reading src/f${i}.ts`,
        at,
      },
      {
        kind: "system" as const,
        label: "差分协处理器" as const,
        body: `Writing src/f${i}.ts`,
        at,
      },
      {
        kind: "herta" as const,
        surface: "speech" as const,
        text: `ok ${i}`,
        at,
      },
    ]).flat();
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "groups-session",
        workspaceRoot: "/r",
        record,
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    // Anti-vacuous: the probe sees the mount — one derivation per group.
    expect(calls.activityChipLabel).toBeGreaterThanOrEqual(GROUPS);

    // A bubble lands: no run changed, so NO group re-derives.
    let before = calls.activityChipLabel;
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "u",
        block: { kind: "user", text: "one more", at },
      });
    });
    expect(calls.activityChipLabel - before).toBe(0);

    // A system block lands and opens a NEW group: exactly that one derives.
    before = calls.activityChipLabel;
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "s1",
        block: {
          kind: "system",
          label: "差分协处理器",
          body: "Reading src/new.ts",
          at,
        },
      });
    });
    expect(calls.activityChipLabel - before).toBe(1);

    // …and it GROWS: still only the live group.
    before = calls.activityChipLabel;
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "s2",
        block: {
          kind: "system",
          label: "差分协处理器",
          body: "Writing src/new.ts",
          at,
        },
      });
    });
    expect(calls.activityChipLabel - before).toBe(1);
    // Anti-vacuous: the live group really holds the new block. A group's rows
    // mount on its first open (ADR 0068 §11), so open the LAST group before
    // looking for the text.
    const toggles = document.querySelectorAll(".activity-line");
    act(() => {
      (toggles[toggles.length - 1] as HTMLButtonElement).click();
    });
    expect(screen.getAllByText(/src\/new\.ts/).length).toBeGreaterThan(0);
  });

  it("a rewind click mid-turn is refused by the handler, not just by CSS", async () => {
    // CSS cannot be a guard — a stale hover, a keyboard activation, or a
    // future style change would walk straight past it into a truncation of the
    // turn that is still running.
    const { mock, view } = mount(2);
    const btn = view.container.querySelector(
      ".message-rewind",
    ) as HTMLButtonElement;
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    btn.click();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mock.calls.rewindLastTurn).toBe(0);
  });
});
