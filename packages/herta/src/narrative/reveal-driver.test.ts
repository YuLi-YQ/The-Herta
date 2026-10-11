import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRevealDriver,
  type RevealDriver,
  type RevealDriverDeps,
} from "./reveal-driver.js";
import { startupDelayMs } from "./slow-stream-pacing.js";

/**
 * Unit tests for the SHARED reveal driver — the branch interplay the three
 * historical sink copies drifted on (fence-inside-hold, word-hold +
 * fastForward re-arm, starvation re-arm, front-gate paths). The sink-level
 * pinning (delta sequences, TTY bytes, fake-timer delays) lives in
 * bus-streaming-sink.test.ts and narrative-renderer.test.ts — those pass
 * UNCHANGED and are the byte-identity proof; these tests pin the driver's
 * own contract so the next drift is caught at the source.
 */

interface Harness {
  readonly driver: RevealDriver;
  /** Every emitRange call as `{ text, start, end }`, in order. */
  readonly emits: { text: string; start: number; end: number }[];
  /** onBegin / onFinish call log (`finish:<begun>`), in order. */
  readonly calls: string[];
  /** True once `done` resolved (microtask-tracked). */
  resolved(): boolean;
}

function mk(over: Partial<RevealDriverDeps> = {}): Harness {
  const emits: { text: string; start: number; end: number }[] = [];
  const calls: string[] = [];
  let resolved = false;
  const driver = createRevealDriver({
    mode: "cjk",
    baseMs: 100,
    random: () => 0.5, // zero jitter
    maxRevealMs: Number.POSITIVE_INFINITY,
    fences: true,
    completionTick: false,
    emitRange: (text, start, end) => emits.push({ text, start, end }),
    onBegin: () => calls.push("begin"),
    onFinish: (begun) => calls.push(`finish:${begun}`),
    ...over,
  });
  driver.done.then(
    () => {
      resolved = true;
    },
    // Swallow the contractual cancel rejection on this DERIVED promise (the
    // driver's own no-op catch covers `done` itself, not `.then` chains).
    () => undefined,
  );
  return { driver, emits, calls, resolved: () => resolved };
}

const joined = (h: Harness): string => h.emits.map((e) => e.text).join("");

describe("createRevealDriver — completion shapes", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("GUI shape (completionTick=false): finishes on the tick that emits the last unit", async () => {
    const h = mk();
    h.driver.pushToken("一二三");
    h.driver.finishInput();
    await vi.advanceTimersByTimeAsync(299);
    expect(h.emits.map((e) => e.text)).toEqual(["一", "二"]);
    expect(h.resolved()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // t=300: last emit + finish, same tick
    expect(h.emits.map((e) => e.text)).toEqual(["一", "二", "三"]);
    expect(h.resolved()).toBe(true);
    expect(h.calls).toEqual(["begin", "finish:true"]);
  });

  it("CLI shape (completionTick=true): the finish lands on a SEPARATE tick after the last unit", async () => {
    const h = mk({ completionTick: true, firstDelayMs: 100 });
    h.driver.pushToken("ab");
    h.driver.finishInput();
    await vi.advanceTimersByTimeAsync(200); // both chars out
    expect(joined(h)).toBe("ab");
    expect(h.resolved()).toBe(false); // completion tick still pending
    await vi.advanceTimersByTimeAsync(100);
    expect(h.resolved()).toBe(true);
    expect(h.calls).toEqual(["begin", "finish:true"]);
  });

  it("empty input finishes with begun=false and zero emits", async () => {
    const h = mk();
    h.driver.pushToken("");
    h.driver.finishInput();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.resolved()).toBe(true);
    expect(h.emits).toEqual([]);
    expect(h.calls).toEqual(["finish:false"]); // onBegin never fired
  });
});

describe("createRevealDriver — front-gate paths", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("supervised short input reveals NOTHING until finishInput, then front-loads the startup", async () => {
    const h = mk({ verdictPending: new Promise<void>(() => {}) });
    h.driver.done.catch(() => undefined);
    h.driver.pushToken("一二三四"); // 4 chars — far below the backlog threshold
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.emits).toEqual([]); // gated: no timer armed at all
    h.driver.finishInput();
    const startup = startupDelayMs({ total: 4, baseMs: 100 }); // 2000
    await vi.advanceTimersByTimeAsync(100 + startup - 1);
    expect(h.emits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(joined(h)).toBe("一");
  });

  it("supervised long backlog opens the reveal at the threshold, before finishInput", async () => {
    const h = mk({ verdictPending: new Promise<void>(() => {}) });
    h.driver.done.catch(() => undefined);
    // threshold = ceil(2800 / 100) = 28 chars
    h.driver.pushToken("零一二三四五六七八九".repeat(3)); // 30 chars ≥ 28
    await vi.advanceTimersByTimeAsync(100);
    expect(joined(h)).toBe("零"); // no startup wait — backlog spans the target
  });

  it("fastForward during the front wait skips the startup remainder", async () => {
    const h = mk({ verdictPending: new Promise<void>(() => {}) });
    h.driver.done.catch(() => undefined);
    h.driver.pushToken("一二三");
    h.driver.finishInput(); // arms the ~2s front-load
    await vi.advanceTimersByTimeAsync(100);
    expect(h.emits).toEqual([]);
    const ff = h.driver.fastForward();
    await vi.advanceTimersByTimeAsync(1_000);
    await ff;
    expect(joined(h)).toBe("一二三");
  });
});

describe("createRevealDriver — fence branch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const code = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
  const fencedText = `\`\`\`\n${code}\n\`\`\``;

  it("fence-inside-hold: the atomic emit clamps to the verdict hold; fastForward drains the rest", async () => {
    const h = mk({ verdictPending: new Promise<void>(() => {}) });
    h.driver.done.catch(() => undefined);
    h.driver.pushToken(fencedText); // long → opens via the backlog threshold
    h.driver.finishInput();
    await vi.advanceTimersByTimeAsync(120_000);
    // ONE clamped emit up to the hold index — the gate held the tail.
    expect(h.emits).toHaveLength(1);
    const total = [...fencedText].length;
    expect([...joined(h)].length).toBeGreaterThan(0);
    expect([...joined(h)].length).toBeLessThan(total);
    // The hold is stable.
    const held = joined(h);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(joined(h)).toBe(held);
    // fastForward (verdict still pending — the escape) drains the remainder.
    const ff = h.driver.fastForward();
    await vi.advanceTimersByTimeAsync(10_000);
    await ff;
    expect(joined(h)).toBe(fencedText);
    expect(h.resolved()).toBe(true);
  });

  it("a still-open fence HOLDS until its close arrives, then emits whole", async () => {
    const h = mk();
    h.driver.pushToken("看：\n```ts\nconst x = 1;\n");
    await vi.runAllTimersAsync();
    expect(joined(h)).toBe("看：\n"); // prose out, open fence held
    h.driver.pushToken("```\n好");
    h.driver.finishInput();
    await vi.runAllTimersAsync();
    expect(joined(h)).toBe("看：\n```ts\nconst x = 1;\n```\n好");
    const fenceEmit = h.emits.find((e) => e.text.startsWith("```ts"));
    expect(fenceEmit?.text).toBe("```ts\nconst x = 1;\n```\n");
    expect(h.resolved()).toBe(true);
  });

  it("fences:false paces a fenced block per unit (the CLI status quo)", async () => {
    const h = mk({ fences: false });
    h.driver.pushToken("```\nab\n```");
    h.driver.finishInput();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.resolved()).toBe(true);
    expect(joined(h)).toBe("```\nab\n```");
    expect(h.emits.every((e) => [...e.text].length === 1)).toBe(true);
  });
});

describe("createRevealDriver — word branch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("word-hold + fastForward re-arm: ff with the verdict STILL PENDING drains fully (no hang)", async () => {
    // The 2026-07 drift class: a bare verdict-only hold cap would return at
    // the boundary with no timer armed once fastForwarding is set, hanging
    // the turn. The shared cap carries the fastForwarding escape.
    const h = mk({
      mode: "word",
      verdictPending: new Promise<void>(() => {}), // never settles
    });
    h.driver.done.catch(() => undefined);
    const text = "The parser cursor now resets correctly and the test passes.";
    h.driver.pushToken(text);
    h.driver.finishInput();
    await vi.advanceTimersByTimeAsync(120_000);
    const held = joined(h);
    expect(held.length).toBeGreaterThan(0);
    expect(held.length).toBeLessThan(text.length);
    expect(held.endsWith(" ")).toBe(true); // held BETWEEN words
    const ff = h.driver.fastForward();
    await vi.advanceTimersByTimeAsync(60_000);
    await ff;
    expect(joined(h)).toBe(text);
    expect(h.resolved()).toBe(true);
  });

  it("partial-word hold with the CJK exemption: a trailing ASCII run waits, a trailing CJK glyph emits", async () => {
    const h = mk({ mode: "word" });
    h.driver.pushToken("Fix");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.emits).toEqual([]); // "Fix" has no terminator yet → held
    h.driver.pushToken("ed ");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(joined(h)).toBe("Fixed "); // completed word emits whole
    h.driver.pushToken("你"); // CJK glyph IS its own complete reveal unit
    await vi.advanceTimersByTimeAsync(5_000);
    expect(joined(h)).toBe("Fixed 你");
    h.driver.finishInput();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.resolved()).toBe(true);
  });
});

describe("createRevealDriver — starvation, ceiling, flushTail, cancel", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a starved reveal re-arms on pushToken and finishes only after finishInput", async () => {
    const h = mk();
    h.driver.pushToken("一二");
    await vi.runAllTimersAsync();
    expect(joined(h)).toBe("一二");
    expect(h.resolved()).toBe(false); // starved at the end, input still open
    h.driver.pushToken("三"); // re-arms from the starved hold
    await vi.runAllTimersAsync();
    expect(joined(h)).toBe("一二三");
    expect(h.resolved()).toBe(false);
    h.driver.finishInput();
    await vi.runAllTimersAsync();
    expect(h.resolved()).toBe(true);
  });

  it("reveal ceiling: past maxRevealMs the tail lands in ONE emit", async () => {
    const h = mk({ maxRevealMs: 1_000 });
    const text = "字".repeat(100);
    h.driver.pushToken(text);
    h.driver.finishInput();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.resolved()).toBe(true);
    expect(joined(h)).toBe(text);
    const last = h.emits[h.emits.length - 1];
    expect([...(last?.text ?? "")].length).toBeGreaterThan(1); // flushed tail
    expect(h.emits.length).toBeLessThan(100);
  });

  it("flushTail lands the exact tail in one range-emit, finishes, and is idempotent", async () => {
    const h = mk();
    h.driver.pushToken("一二三四五");
    h.driver.finishInput();
    await vi.advanceTimersByTimeAsync(200); // 2 chars out
    expect(joined(h)).toBe("一二");
    h.driver.flushTail();
    expect(h.emits[h.emits.length - 1]).toEqual({
      text: "三四五",
      start: 2,
      end: 5,
    });
    await Promise.resolve();
    expect(h.resolved()).toBe(true);
    const count = h.emits.length;
    h.driver.flushTail(); // idempotent
    await vi.advanceTimersByTimeAsync(10_000); // no further ticks
    expect(h.emits.length).toBe(count);
  });

  it("cancel stops the loop, rejects done, and reports the transition exactly once", async () => {
    const h = mk();
    h.driver.pushToken("一二三四五");
    h.driver.finishInput();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.driver.cursor).toBe(2);
    expect(h.driver.cancel()).toBe(true);
    await expect(h.driver.done).rejects.toThrow("slow-stream cancelled");
    const count = h.emits.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.emits.length).toBe(count); // loop is dead
    expect(h.driver.cancel()).toBe(false); // repeat call reports no transition
    h.driver.pushToken("六"); // no-op after cancel
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.emits.length).toBe(count);
    // onFinish is NOT called on cancel — the sink owns its cancel visuals.
    expect(h.calls).toEqual(["begin"]);
  });

  it("cancel after natural completion still reports the transition (late-veto retract case)", async () => {
    const h = mk();
    h.driver.pushToken("一");
    h.driver.finishInput();
    await vi.runAllTimersAsync();
    expect(h.resolved()).toBe(true);
    expect(h.driver.cancel()).toBe(true); // the GUI retracts settled text here
    expect(h.driver.cancel()).toBe(false);
  });
});
