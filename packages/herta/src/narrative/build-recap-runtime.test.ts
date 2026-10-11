import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ProviderEvent } from "@herta/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRecapRuntime } from "./build-recap-runtime.js";
import { promptAssetsFor } from "./prompt-assets.js";
import { readRecapCache } from "./recap-cache.js";
import { DEFAULT_COMPACTION_CONFIG } from "./session-recap.js";

const SIGNAL = new AbortController().signal;

async function* streamOf(
  events: ProviderEvent[],
): AsyncGenerator<ProviderEvent> {
  for (const e of events) yield e;
}

/** A fake router provider whose streamChat is a vi.fn replaying a fixed
 *  one-delta stream, so tests can assert it was invoked. */
function fakeProvider(): ProviderAdapter {
  return {
    streamChat: vi.fn(
      (_frame, _signal): AsyncIterable<ProviderEvent> =>
        streamOf([
          { type: "text-delta", text: "回顾。" },
          { type: "finish", reason: "stop" },
        ]),
    ),
  };
}

describe("buildRecapRuntime", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "build-recap-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The guide/bio voice anchors come from the COMPILED per-lang prompt
  // bundle (M-prompts-1 / D1), NOT from workspace files. They were
  // originally read from `.herta/narrative*` — which M-prompts-1 emptied,
  // so every real session ran with "" anchors while the old tests created
  // the files in fixtures and never noticed. The live recap lab caught it
  // (2026-07-17). These tests pin the compiled source: anchors must be
  // non-empty in a BARE workspace with no .herta at all.
  it("guide/bio come from the compiled bundle — non-empty in a bare workspace", async () => {
    const rt = await buildRecapRuntime({
      routerProvider: fakeProvider(),
      workspaceRoot: dir, // empty temp dir: no .herta anywhere
      sessionId: "sess1",
    });
    expect(rt.guide).toBe(promptAssetsFor("zh").hertaGuide);
    expect(rt.guide.length).toBeGreaterThan(0);
    expect(rt.bio.length).toBeGreaterThan(0);
  });

  it("bio is a bounded head excerpt of the compiled HertaBio", async () => {
    const rt = await buildRecapRuntime({
      routerProvider: fakeProvider(),
      workspaceRoot: dir,
      sessionId: "sess1",
    });
    const full = promptAssetsFor("zh").hertaBio;
    expect(rt.bio).toBe(full.slice(0, DEFAULT_COMPACTION_CONFIG.maxBioChars));
    expect(rt.bio.length).toBeLessThanOrEqual(
      DEFAULT_COMPACTION_CONFIG.maxBioChars,
    );
  });

  it("defaults to enabled:false and otherwise copies DEFAULT_COMPACTION_CONFIG", async () => {
    const provider = fakeProvider();
    const rt = await buildRecapRuntime({
      routerProvider: provider,
      workspaceRoot: dir,
      sessionId: "sess1",
    });
    expect(rt.config).toEqual({ ...DEFAULT_COMPACTION_CONFIG, enabled: false });
    expect(rt.consecutiveFailures).toBe(0);
    expect(rt.skippedWhileOpen).toBe(0);
  });

  it("honors an explicit enabled:true", async () => {
    const provider = fakeProvider();
    const rt = await buildRecapRuntime({
      routerProvider: provider,
      workspaceRoot: dir,
      sessionId: "sess1",
      enabled: true,
    });
    expect(rt.config.enabled).toBe(true);
  });

  // The per-lang bundle switch: an EN session's voice anchors come from the
  // EN bundle, never the ZH one (the pre-2026-07-17 concern — an EN session
  // reading ZH anchors — is now structurally impossible: promptAssetsFor is
  // the single switch).
  it("selects the compiled bundle per lang — en anchors differ from zh", async () => {
    const zhRt = await buildRecapRuntime({
      routerProvider: fakeProvider(),
      workspaceRoot: dir,
      sessionId: "sess1",
      lang: "zh",
    });
    const enRt = await buildRecapRuntime({
      routerProvider: fakeProvider(),
      workspaceRoot: dir,
      sessionId: "sess1",
      lang: "en",
    });
    expect(enRt.guide).toBe(promptAssetsFor("en").hertaGuide);
    expect(enRt.guide.length).toBeGreaterThan(0);
    expect(enRt.bio.length).toBeGreaterThan(0);
    expect(enRt.guide).not.toBe(zhRt.guide);
    expect(enRt.bio).not.toBe(zhRt.bio);
  });

  it("wires cacheRead/cacheWrite against workspaceRoot + sessionId", async () => {
    const provider = fakeProvider();
    const rt = await buildRecapRuntime({
      routerProvider: provider,
      workspaceRoot: dir,
      sessionId: "sess-cache",
    });
    expect(rt.cacheRead()).toBeNull();
    const cache = {
      boundaryIndex: 4,
      recapText: "存档",
      lang: "zh",
      advancesSinceRederive: 1,
    } as const;
    rt.cacheWrite(cache);
    expect(rt.cacheRead()).toEqual(cache);
    // The write landed under the right sessionId, not some other one.
    expect(readRecapCache(dir, "sess-cache")).toEqual(cache);
    expect(readRecapCache(dir, "other")).toBeNull();
  });

  it('defaults lang to "zh" and honors an explicit "en" (slice 4)', async () => {
    const zhRt = await buildRecapRuntime({
      routerProvider: fakeProvider(),
      workspaceRoot: dir,
      sessionId: "sess1",
    });
    expect(zhRt.lang).toBe("zh");
    const enRt = await buildRecapRuntime({
      routerProvider: fakeProvider(),
      workspaceRoot: dir,
      sessionId: "sess1",
      lang: "en",
    });
    expect(enRt.lang).toBe("en");
  });

  it("wires summarize to the router provider", async () => {
    const provider = fakeProvider();
    const rt = await buildRecapRuntime({
      routerProvider: provider,
      workspaceRoot: dir,
      sessionId: "sess1",
    });
    const out = await rt.summarize({
      system: "SYS",
      user: "USR",
      signal: SIGNAL,
    });
    expect(out).toBe("回顾。");
    expect(provider.streamChat).toHaveBeenCalledTimes(1);
  });
});
