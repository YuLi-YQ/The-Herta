import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../context/HertaBridgeContext.js";
import { createMockHertaBridge } from "../ipc/mock-bridge.js";
import { stopAllVoice } from "../voice/play-voice.js";
import { useVoiceCues } from "./useVoiceCues.js";

function Harness(): null {
  useVoiceCues();
  return null;
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  readonly src: string;
  currentTime = 0;
  readonly play = vi.fn((): Promise<void> => Promise.resolve());
  readonly pause = vi.fn();
  readonly addEventListener = vi.fn();
  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
}

describe("useVoiceCues", () => {
  afterEach(() => {
    // Unmount first (runs the hook's effect cleanup), then clear the
    // module-level `active` set so audio from one test can't leak into the
    // next, then drop the global stub + instance log.
    cleanup();
    stopAllVoice();
    FakeAudio.instances = [];
    vi.unstubAllGlobals();
  });

  function stubAudio(): typeof FakeAudio {
    vi.stubGlobal("Audio", FakeAudio as never);
    return FakeAudio;
  }

  function mountWith(mock: ReturnType<typeof createMockHertaBridge>): void {
    render(
      <HertaBridgeProvider bridge={mock.bridge}>
        <Harness />
      </HertaBridgeProvider>,
    );
  }

  it("autoplays the clip on a voice cue", () => {
    const Audio = stubAudio();
    const mock = createMockHertaBridge();
    mountWith(mock);
    mock.emitVoice({
      kind: "cue",
      category: "openings",
      clipId: "002-puppet-twitch",
    });
    expect(Audio.instances.map((a) => a.src)).toEqual([
      "herta-voice://clip/openings/002-puppet-twitch.opus",
    ]);
    expect(Audio.instances[0]?.play).toHaveBeenCalledOnce();
  });

  it("ignores the dropped sentinel", () => {
    const Audio = stubAudio();
    const mock = createMockHertaBridge();
    mountWith(mock);
    mock.emitVoice({ kind: "dropped", count: 3 });
    expect(Audio.instances).toEqual([]);
  });

  it("stops in-flight audio when the session resets (switch / new)", () => {
    const Audio = stubAudio();
    const mock = createMockHertaBridge();
    mountWith(mock);
    mock.emitVoice({ kind: "cue", category: "openings", clipId: "a" });
    expect(Audio.instances).toHaveLength(1);
    mock.emitReset({ noSession: true });
    expect(Audio.instances[0]?.pause).toHaveBeenCalledOnce();
  });

  function activate(
    mock: ReturnType<typeof createMockHertaBridge>,
    sessionId: string,
  ): void {
    mock.emitReset({
      sessionId,
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
  }

  it("stops in-flight audio when the OPEN session is deleted", () => {
    const Audio = stubAudio();
    const mock = createMockHertaBridge();
    mountWith(mock);
    activate(mock, "open-1");
    mock.emitVoice({ kind: "cue", category: "openings", clipId: "a" });
    expect(Audio.instances).toHaveLength(1);
    mock.emitSessionDeleted({ sessionId: "open-1" });
    expect(Audio.instances[0]?.pause).toHaveBeenCalledOnce();
  });

  it("does NOT cut audio when some OTHER session is deleted (audit 2026-07-24, M8)", () => {
    // Deleting an unrelated old card from the sidebar is allowed mid-turn;
    // an unscoped handler cut Herta mid-sentence while her text kept typing
    // at the clip-matched pace. The hook's own docstring already scoped this
    // to "the open session" — the guard was simply missing.
    const Audio = stubAudio();
    const mock = createMockHertaBridge();
    mountWith(mock);
    activate(mock, "open-1");
    mock.emitVoice({ kind: "cue", category: "openings", clipId: "a" });
    expect(Audio.instances).toHaveLength(1);
    mock.emitSessionDeleted({ sessionId: "some-other-old-session" });
    expect(Audio.instances[0]?.pause).not.toHaveBeenCalled();
  });

  it("does not cut a clip that starts after the reset (new session's opening)", () => {
    const Audio = stubAudio();
    const mock = createMockHertaBridge();
    mountWith(mock);
    // Switch first (nothing playing), then the new session's opening cue lands.
    mock.emitReset({ noSession: true });
    mock.emitVoice({ kind: "cue", category: "openings", clipId: "new" });
    expect(Audio.instances).toHaveLength(1);
    expect(Audio.instances[0]?.pause).not.toHaveBeenCalled();
    expect(Audio.instances[0]?.play).toHaveBeenCalledOnce();
  });

  it("stops in-flight audio when the turn is INTERRUPTED (stop button, 2026-07-13)", () => {
    const Audio = stubAudio();
    const mock = createMockHertaBridge();
    mountWith(mock);
    mock.emitVoice({ kind: "cue", category: "openings", clipId: "a" });
    expect(Audio.instances).toHaveLength(1);
    mock.emitTurn({
      kind: "failed",
      turnId: "t1",
      error: { code: "AbortError", message: "interrupted" },
    });
    expect(Audio.instances[0]?.pause).toHaveBeenCalledOnce();
  });

  it("does NOT cut the clip on a natural turn finish (the opening's audio tail outlives the text)", () => {
    const Audio = stubAudio();
    const mock = createMockHertaBridge();
    mountWith(mock);
    mock.emitVoice({ kind: "cue", category: "openings", clipId: "a" });
    mock.emitTurn({ kind: "finished", turnId: "t1" });
    expect(Audio.instances[0]?.pause).not.toHaveBeenCalled();
  });
});
