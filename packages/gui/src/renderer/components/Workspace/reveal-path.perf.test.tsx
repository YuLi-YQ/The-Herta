import { stripDisplayUnsafe } from "@herta/core/text-sanitize";
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { useActiveSession } from "../../hooks/useActiveSession.js";
import { LocaleProvider } from "../../i18n/LocaleProvider.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import {
  resetRevealPerf,
  setRevealPerfEnabled,
  snapshotRevealPerf,
} from "../../lib/reveal-perf.js";
import { segmentSpeech } from "../../lib/segment-speech.js";
import {
  type SpeechKicksSource,
  useSpeechEnvelope,
} from "../UtilityRail/useSpeechEnvelope.js";
import { StreamingReply } from "./StreamingReply.js";

/**
 * Reveal-path perf harness (2026-08-25).
 *
 * Streams one long synthetic reply through the REAL live-bubble stack
 * (StreamingReply + the voice-wave envelope) under a manually pumped rAF,
 * with the reveal-perf spans enabled, then reports how much scan work
 * (chars examined / wall ms) each derivation did for the whole reply.
 *
 * The report is the point — run `vitest run reveal-path.perf` and read the
 * `[reveal-perf]` lines. The assertions are the standing part: they pin
 * that the derivations stay CORRECT (rendered rows match the batch
 * segmentation of the full text, the scrub really removes display-unsafe
 * chars, the wave still gets kicks) and that the spans stay wired
 * (calls > 0), so the instrumentation can't silently rot. No timing
 * assertions — machines vary; the chars metric is the comparable one.
 */

afterEach(() => {
  vi.restoreAllMocks();
  setRevealPerfEnabled(false);
  resetRevealPerf();
});

/** Manual rAF pump: no fake timers (they'd freeze performance.now and zero
 *  the ms totals). Callbacks scheduled during a pump land in the NEXT one. */
function mockManualRaf(): { pump: (frames: number) => void } {
  const queued = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  let now = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    const id = nextId++;
    queued.set(id, cb);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    queued.delete(id as number);
  });
  return {
    pump: (frames: number): void => {
      for (let f = 0; f < frames; f++) {
        const batch = [...queued.values()];
        queued.clear();
        now += 16;
        act(() => {
          for (const cb of batch) cb(now);
        });
      }
    },
  };
}

/** ~6K-char EN-mode reply: >MAX_SEGMENTS paragraphs (exercises the fold), a
 *  fenced code block as an early unit, inline code + a mention in the early
 *  paragraphs, plain tail paragraphs (so the folded last row's textContent
 *  equals its segment text byte-for-byte), and planted display-unsafe chars
 *  (a bidi override U+202E + an ESC U+001B) that the scrub must remove. */
function buildReply(): string {
  const paras: string[] = [];
  paras.push(
    `Right${"\u202E\u001B"}, let me walk the sampler once more. ${"The cursor drifts by one frame each pass, which is exactly the kind of defect that hides in an even cadence. ".repeat(3)}See \`segmentSpeech\` — and @板砖 already has the diff.`,
  );
  paras.push(
    "```ts\nconst cadence = frames.map((f) => f.cost);\nconst drift = cadence.at(-1)! - cadence[0]!;\n```",
  );
  for (let i = 2; i < 11; i++) {
    paras.push(
      `Paragraph ${i}: ${"steady prose with no markup so the folded tail stays a single text node. ".repeat(7)}End of section ${i}.`,
    );
  }
  return paras.join("\n\n");
}

/** Mirrors Conversation's wiring of the live bubble, minus the morph edges. */
function StreamHarness(props: { renders: { count: number } }): JSX.Element {
  props.renders.count += 1;
  const snap = useActiveSession();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const cloneRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  return (
    <StreamingReply
      lang={snap.lang}
      streamingText={snap.streamingText}
      retryText={snap.retryText}
      retracting={snap.retracting}
      retractKeepLen={snap.retractKeepLen}
      reduced={false}
      hideStreaming={false}
      showIncomingClone={false}
      streamingBubbleRef={bubbleRef}
      incomingCloneRef={cloneRef}
      overlayRef={overlayRef}
      onGrow={() => {}}
    />
  );
}

function EnvelopeProbe(props: {
  renders: { count: number };
  out: { source?: SpeechKicksSource };
}): null {
  props.renders.count += 1;
  props.out.source = useSpeechEnvelope();
  return null;
}

describe("reveal path — perf harness + derivation equivalence", () => {
  it("streams a long reply; reports span work; rendered rows match batch segmentation", () => {
    const raf = mockManualRaf();
    const mock = createMockHertaBridge();
    const streamRenders = { count: 0 };
    const envelopeRenders = { count: 0 };
    const envelope: { source?: SpeechKicksSource } = {};
    const { container } = render(
      <LocaleProvider locale="zh" onLocaleChange={() => {}}>
        <HertaBridgeProvider bridge={mock.bridge}>
          <StreamHarness renders={streamRenders} />
          <EnvelopeProbe renders={envelopeRenders} out={envelope} />
        </HertaBridgeProvider>
      </LocaleProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s-perf",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
        // EN word-stream reveal (≤48 cp/frame): the derivation code under
        // measurement is identical to zh, at 1/16th the frame count.
        lang: "en",
      });
      mock.emitTurn({ kind: "started", turnId: "t-perf" });
    });

    const full = buildReply();
    const DELTA = 40;
    setRevealPerfEnabled(true);
    let deltas = 0;
    for (let i = 0; i < full.length; i += DELTA) {
      const chunk = full.slice(i, i + DELTA);
      act(() => {
        mock.emitAgent({
          kind: "agent",
          event: {
            type: "assistant.delta",
            layer: "actor",
            text: chunk,
          } as never,
        });
      });
      deltas += 1;
      raf.pump(1);
    }
    // Drain: enough frames for the reveal to finish the buffered tail.
    raf.pump(40);
    setRevealPerfEnabled(false);

    // ---- Equivalence: the live stack must equal the batch derivation. ----
    const expected = segmentSpeech(stripDisplayUnsafe(full));
    const rows = container.querySelectorAll(
      "[data-testid='streaming-bubble'], [data-testid='streaming-bubble-cont']",
    );
    expect(rows.length).toBe(expected.length);
    // Planted display-unsafe chars never reach the DOM; their neighbors do.
    expect(container.textContent).not.toContain("\u202E");
    expect(container.textContent).not.toContain("\u001B");
    expect(container.textContent).toContain("Right, let me walk the sampler");
    // The early code unit renders as the standalone card, byte-identical.
    const code = expected.find((s) => s.kind === "code");
    expect(code).toBeDefined();
    expect(container.querySelector(".code-standalone pre")?.textContent).toBe(
      code?.text,
    );
    // The folded last row (overflow past MAX_SEGMENTS) is markup-free by
    // construction, so its textContent equals the segment text exactly.
    const last = expected[expected.length - 1];
    expect(last?.kind).toBe("prose");
    expect(rows[rows.length - 1]?.textContent).toBe(last?.text);
    // The wave got fed: speakable growth accumulated kicks across the stream.
    const kicks = envelope.source?.drainKicks();
    expect(kicks).toBeDefined();
    expect(kicks?.count ?? 0).toBeGreaterThan(100);

    // ---- Report. ----
    const spans = snapshotRevealPerf();
    for (const name of [
      "reveal.strip",
      "reveal.segment",
      "bubble.tokenize",
      "envelope.scan",
    ]) {
      expect(spans[name]?.calls ?? 0).toBeGreaterThan(0);
    }
    const lines = [
      `[reveal-perf] reply=${full.length} chars, ${deltas} deltas, segments=${expected.length}`,
      `[reveal-perf] renders: stream=${streamRenders.count} envelope=${envelopeRenders.count}`,
      ...Object.entries(spans).map(
        ([name, t]) =>
          `[reveal-perf] ${name.padEnd(16)} calls=${String(t.calls).padStart(4)} chars=${String(t.chars).padStart(9)} (${(t.chars / full.length).toFixed(1)}x reply) ms=${t.ms.toFixed(1)}`,
      ),
    ];
    console.info(lines.join("\n"));
  });
});
