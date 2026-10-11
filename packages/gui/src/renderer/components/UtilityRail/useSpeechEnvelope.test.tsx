import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { publishRevealedSpeech } from "../../lib/reveal-source.js";
import { useSpeechEnvelope } from "./useSpeechEnvelope.js";

// The envelope subscribes to the shared reveal source (what StreamingReply
// actually paints) — tests drive growth by publishing there, which is the
// production wiring minus the bubble. The reveal-path perf harness covers
// the full StreamingReply → reveal-source → envelope integration.

afterEach(() => {
  publishRevealedSpeech(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(lang?: "zh" | "en") {
  const mock = createMockHertaBridge();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <HertaBridgeProvider bridge={mock.bridge}>{children}</HertaBridgeProvider>
  );
  const renders = { count: 0 };
  const rendered = renderHook(
    () => {
      renders.count += 1;
      return useSpeechEnvelope();
    },
    { wrapper },
  );
  act(() => {
    mock.emitReset({
      sessionId: `s-${lang ?? "zh"}`,
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
      ...(lang !== undefined ? { lang } : {}),
    });
    // Deltas only flow inside a turn on the real wire (the store drops
    // out-of-turn deltas — the phantom-bubble guard).
    mock.emitTurn({ kind: "started", turnId: `t-${lang ?? "zh"}` });
  });
  return { mock, rendered, renders };
}

const delta = (text: string) =>
  ({
    kind: "agent",
    event: { type: "assistant.delta", layer: "actor", text } as never,
  }) as const;

describe("useSpeechEnvelope", () => {
  it("accumulates kicks as the revealed text grows; drain resets", () => {
    const { rendered } = setup();
    act(() => {
      publishRevealedSpeech("你");
      publishRevealedSpeech("你好");
    });
    const k = rendered.result.current.drainKicks();
    expect(k.count).toBeGreaterThanOrEqual(2);
    // Drained: a second drain with no growth is empty.
    const k2 = rendered.result.current.drainKicks();
    expect(k2.count).toBe(0);
    expect(k2.punctuation).toBeNull();
  });

  it("never re-renders its owner while speech streams (imperative refs only)", () => {
    const { rendered, renders } = setup();
    const before = renders.count;
    act(() => {
      for (let i = 1; i <= 20; i++) {
        publishRevealedSpeech("一些流式文本。".repeat(i));
      }
    });
    expect(renders.count).toBe(before);
    expect(rendered.result.current.drainKicks().count).toBeGreaterThan(0);
  });

  it("classifies hard and soft punctuation from the last revealed char", () => {
    const { rendered } = setup();
    act(() => {
      publishRevealedSpeech("好。");
    });
    expect(rendered.result.current.drainKicks().punctuation).toBe("hard");
    act(() => {
      publishRevealedSpeech("好。嗯，");
    });
    expect(rendered.result.current.drainKicks().punctuation).toBe("soft");
  });

  it("classifies an EN sentence end (. ! ?) as a HARD breath in an EN session", () => {
    const { rendered } = setup("en");
    act(() => {
      publishRevealedSpeech("Done.");
    });
    // The wave settles where the sink's EN sentence breath pauses the text.
    expect(rendered.result.current.drainKicks().punctuation).toBe("hard");
  });

  it("does NOT treat an ASCII '.' as a hard breath in a zh session (byte-identity)", () => {
    const { rendered } = setup("zh");
    // A zh reply mentioning a version / path ends in ASCII "." — never a break.
    act(() => {
      publishRevealedSpeech("看 v0.");
    });
    expect(rendered.result.current.drainKicks().punctuation).toBeNull();
  });

  it("keeps kicking from retryText during a retract (the shrink itself is silent)", () => {
    const { mock, rendered } = setup();
    act(() => {
      publishRevealedSpeech("候选");
    });
    rendered.result.current.drainKicks(); // clear the candidate's kicks
    act(() => {
      mock.emitSpeech({ kind: "retract" });
    });
    // The shrink: the reveal holds still (StreamingReply publishes no
    // growth while the morph owns the visual) — no kicks.
    expect(rendered.result.current.drainKicks().count).toBe(0);
    // Retry deltas (buffered into retryText during the retract) kick again.
    act(() => {
      mock.emitAgent(delta("修订"));
    });
    expect(rendered.result.current.drainKicks().count).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("a streaming code block produces zero kicks; surrounding prose kicks", () => {
    const { rendered } = setup();
    act(() => {
      publishRevealedSpeech("看这个：\n");
    });
    expect(rendered.result.current.drainKicks().count).toBeGreaterThan(0);
    // The fence + code stream in: no speakable growth → no kicks.
    act(() => {
      publishRevealedSpeech("看这个：\n```ts\n");
      publishRevealedSpeech("看这个：\n```ts\nconst x = 1;\n");
      publishRevealedSpeech("看这个：\n```ts\nconst x = 1;\n```\n");
    });
    expect(rendered.result.current.drainKicks().count).toBe(0);
    // Prose after the fence kicks again.
    act(() => {
      publishRevealedSpeech("看这个：\n```ts\nconst x = 1;\n```\n就这样。");
    });
    expect(rendered.result.current.drainKicks().count).toBeGreaterThanOrEqual(
      3,
    );
  });

  it("a reveal reset (turn end / session switch) does not produce negative or spurious kicks", () => {
    const { mock, rendered } = setup();
    act(() => {
      publishRevealedSpeech("一些文本");
    });
    rendered.result.current.drainKicks();
    act(() => {
      publishRevealedSpeech(null);
      mock.emitReset({
        sessionId: "s2",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    expect(rendered.result.current.drainKicks().count).toBe(0);
  });
});
