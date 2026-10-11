import { afterEach, describe, expect, it, vi } from "vitest";
import { voiceClipUrl } from "../../shared/voice.js";
import {
  applyVoiceVolume,
  isVoicePlaying,
  playVoiceClip,
  stopAllVoice,
  subscribeVoicePlaying,
} from "./play-voice.js";
import { setVoiceMuted, setVoiceVolume } from "./voice-prefs.js";

describe("voiceClipUrl", () => {
  it("builds a herta-voice:// url, percent-encoding each segment", () => {
    expect(voiceClipUrl("openings", "004-late-night-audit")).toBe(
      "herta-voice://clip/openings/004-late-night-audit.opus",
    );
    expect(voiceClipUrl("particle/嗯", "01")).toBe(
      `herta-voice://clip/particle/${encodeURIComponent("嗯")}/01.opus`,
    );
  });
});

/** Minimal HTMLAudioElement stand-in. Records play/pause and captures the
 *  'ended'/'error' listeners so a test can fire them to exercise self-cleanup. */
class FakeAudio {
  static instances: FakeAudio[] = [];
  readonly src: string;
  currentTime = 0;
  volume = 1;
  readonly play = vi.fn((): Promise<void> => Promise.resolve());
  readonly pause = vi.fn();
  readonly listeners = new Map<string, () => void>();
  readonly addEventListener = vi.fn((type: string, cb: () => void) => {
    this.listeners.set(type, cb);
  });
  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
}

describe("playVoiceClip / stopAllVoice", () => {
  afterEach(() => {
    // Empty the module-level `active` set between tests, then drop the stub.
    stopAllVoice();
    setVoiceMuted(false);
    setVoiceVolume(1);
    FakeAudio.instances = [];
    vi.unstubAllGlobals();
  });

  function stub(): typeof FakeAudio {
    vi.stubGlobal("Audio", FakeAudio as never);
    return FakeAudio;
  }

  it("constructs an Audio for the clip and plays it", () => {
    const Audio = stub();
    playVoiceClip("openings", "001-morning-cold-tea");
    expect(Audio.instances.map((a) => a.src)).toEqual([
      "herta-voice://clip/openings/001-morning-cold-tea.opus",
    ]);
    expect(Audio.instances[0]?.play).toHaveBeenCalledTimes(1);
  });

  it("swallows a play() rejection (best-effort)", () => {
    class Rejecting {
      play = (): Promise<void> => Promise.reject(new Error("blocked"));
      addEventListener = (): void => undefined;
    }
    vi.stubGlobal("Audio", Rejecting as never);
    expect(() => playVoiceClip("openings", "x")).not.toThrow();
  });

  it("swallows an Audio constructor throw (best-effort)", () => {
    class Throwing {
      constructor(_src: string) {
        throw new Error("no audio");
      }
    }
    vi.stubGlobal("Audio", Throwing as never);
    expect(() => playVoiceClip("openings", "x")).not.toThrow();
  });

  it("a new clip interrupts the one already playing (newest wins)", () => {
    const Audio = stub();
    playVoiceClip("openings", "a");
    expect(Audio.instances[0]?.pause).not.toHaveBeenCalled(); // a is playing
    playVoiceClip("particle/嗯", "01");
    expect(Audio.instances).toHaveLength(2);
    // a was stopped + rewound when b started; b is now the only one playing.
    expect(Audio.instances[0]?.pause).toHaveBeenCalledOnce();
    expect(Audio.instances[0]?.currentTime).toBe(0);
    expect(Audio.instances[1]?.pause).not.toHaveBeenCalled();
    expect(Audio.instances[1]?.play).toHaveBeenCalledOnce();
  });

  it("stopAllVoice pauses and rewinds the active clip", () => {
    const Audio = stub();
    playVoiceClip("openings", "a");
    stopAllVoice();
    expect(Audio.instances[0]?.pause).toHaveBeenCalledOnce();
    expect(Audio.instances[0]?.currentTime).toBe(0);
  });

  it("stopAllVoice is idempotent — a second call pauses nothing new", () => {
    const Audio = stub();
    playVoiceClip("openings", "a");
    stopAllVoice();
    stopAllVoice();
    expect(Audio.instances[0]?.pause).toHaveBeenCalledOnce();
  });

  it("an ended clip is dropped from tracking, so stopAllVoice skips it", () => {
    const Audio = stub();
    playVoiceClip("openings", "a");
    // Fire 'ended' → self-cleanup removes it from `active`.
    Audio.instances[0]?.listeners.get("ended")?.();
    stopAllVoice();
    expect(Audio.instances[0]?.pause).not.toHaveBeenCalled();
  });

  it("isVoicePlaying is false initially, true while playing, false once ended", () => {
    const Audio = stub();
    expect(isVoicePlaying()).toBe(false);
    playVoiceClip("easter_egg", "x");
    expect(isVoicePlaying()).toBe(true);
    Audio.instances[0]?.listeners.get("ended")?.(); // clip finished
    expect(isVoicePlaying()).toBe(false);
  });

  it("isVoicePlaying goes false after stopAllVoice", () => {
    stub();
    playVoiceClip("openings", "a");
    expect(isVoicePlaying()).toBe(true);
    stopAllVoice();
    expect(isVoicePlaying()).toBe(false);
  });

  it("plays nothing while muted (no Audio, isVoicePlaying stays false)", () => {
    const Audio = stub();
    setVoiceMuted(true);
    playVoiceClip("easter_egg", "x");
    expect(Audio.instances).toEqual([]);
    expect(isVoicePlaying()).toBe(false);
    // Unmute → plays again.
    setVoiceMuted(false);
    playVoiceClip("openings", "a");
    expect(Audio.instances).toHaveLength(1);
  });

  it("applies the master volume at creation", () => {
    const Audio = stub();
    setVoiceVolume(0.35);
    playVoiceClip("openings", "a");
    expect(Audio.instances[0]?.volume).toBe(0.35);
  });

  it("applyVoiceVolume re-scales a clip that is already playing", () => {
    const Audio = stub();
    playVoiceClip("openings", "a");
    expect(Audio.instances[0]?.volume).toBe(1);
    setVoiceVolume(0.2);
    applyVoiceVolume();
    expect(Audio.instances[0]?.volume).toBe(0.2);
  });

  it("notifies subscribers on start and stop, not after unsubscribe", () => {
    stub();
    let n = 0;
    const unsub = subscribeVoicePlaying(() => {
      n += 1;
    });
    playVoiceClip("veto", "x"); // start → notify
    expect(n).toBeGreaterThanOrEqual(1);
    const afterStart = n;
    stopAllVoice(); // stop → notify
    expect(n).toBeGreaterThan(afterStart);
    const afterStop = n;
    unsub();
    playVoiceClip("veto", "y"); // no longer subscribed
    expect(n).toBe(afterStop);
  });
});
