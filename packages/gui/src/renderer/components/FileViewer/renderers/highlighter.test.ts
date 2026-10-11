import { describe, expect, it, vi } from "vitest";
import type { HighlightReply, HighlightRequest } from "./highlight.worker.js";
import { createHighlightClient, viewerHighlighter } from "./highlighter.js";

/** A stand-in for the bundled worker: records what was posted, replies when
 *  the test says so, and can fail the way a worker whose script would not
 *  load does. */
class FakeWorker extends EventTarget {
  readonly posted: HighlightRequest[] = [];
  terminated = false;
  postMessage(message: HighlightRequest): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(reply: HighlightReply): void {
    this.dispatchEvent(new MessageEvent("message", { data: reply }));
  }
  fail(): void {
    this.dispatchEvent(new Event("error"));
  }
}

const realHighlighter = () => import("./highlight.js");

describe("the viewer's highlighter client (ADR 0068 §12)", () => {
  it("without a worker, the answer comes from the main-thread highlighter", async () => {
    const client = createHighlightClient({
      spawnWorker: () => null,
      loadHighlighter: realHighlighter,
    });
    const html = await client.highlight('const a = "<b>";', "typescript");
    expect(html).toContain('class="hljs-keyword"');
    expect(html).toContain("&lt;b&gt;");
    // The same null answers as the main-thread function.
    expect(await client.highlight("x", "no-such-language")).toBeNull();
  });

  it("with a worker, the request rides it and the reply resolves its own request; the main thread is never asked", async () => {
    const fake = new FakeWorker();
    const load = vi.fn(realHighlighter);
    const client = createHighlightClient({
      spawnWorker: () => fake as unknown as Worker,
      loadHighlighter: load,
    });
    const first = client.highlight("const a = 1;", "typescript");
    const second = client.highlight("let b = 2;", "javascript");
    expect(fake.posted).toHaveLength(2);
    expect(fake.posted[0]).toMatchObject({
      code: "const a = 1;",
      language: "typescript",
    });
    expect(fake.posted[0]?.id).not.toBe(fake.posted[1]?.id);
    // Replies out of order still land on their own requests.
    fake.reply({ id: fake.posted[1]?.id ?? -1, html: "<span>two</span>" });
    fake.reply({ id: fake.posted[0]?.id ?? -1, html: "<span>one</span>" });
    expect(await first).toBe("<span>one</span>");
    expect(await second).toBe("<span>two</span>");
    expect(load).not.toHaveBeenCalled();
    // A reply nobody asked for is ignored, not a crash.
    fake.reply({ id: 999, html: "stray" });
  });

  it("a worker that errors is retired: what it owed answers on the main thread, and no later request goes near a worker", async () => {
    const fake = new FakeWorker();
    const spawn = vi.fn(() => fake as unknown as Worker);
    const client = createHighlightClient({
      spawnWorker: spawn,
      loadHighlighter: realHighlighter,
    });
    const owed = client.highlight('const a = "<b>";', "typescript");
    expect(fake.posted).toHaveLength(1);
    fake.fail();
    const html = await owed;
    expect(html).toContain('class="hljs-keyword"');
    expect(fake.terminated).toBe(true);
    // Later: straight to the main thread, no second worker.
    const again = await client.highlight("let b = 2;", "javascript");
    expect(again).toContain('class="hljs-keyword"');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(fake.posted).toHaveLength(1);
    // A late message from the retired worker resolves nothing twice.
    fake.reply({ id: fake.posted[0]?.id ?? -1, html: "late" });
    expect(await owed).toBe(html);
  });

  it("a worker that fails to construct counts as none", async () => {
    const client = createHighlightClient({
      spawnWorker: () => {
        throw new Error("refused");
      },
      loadHighlighter: realHighlighter,
    });
    const html = await client.highlight("const a = 1;", "typescript");
    expect(html).toContain('class="hljs-keyword"');
  });

  it("the default client answers where there is no Worker at all (jsdom)", async () => {
    // Anti-vacuous: this environment really has none, so the bundled-worker
    // branch is the one being skipped.
    expect(typeof Worker).toBe("undefined");
    const html = await viewerHighlighter.highlight(
      "const a = 1;",
      "typescript",
    );
    expect(html).toContain('class="hljs-keyword"');
  });
});
