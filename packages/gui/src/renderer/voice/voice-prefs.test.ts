import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getVoiceVolume,
  isVoiceMuted,
  setVoiceMuted,
  setVoiceVolume,
  subscribeVoiceMuted,
  subscribeVoiceVolume,
} from "./voice-prefs.js";

describe("voice-prefs", () => {
  afterEach(() => {
    setVoiceMuted(false);
    setVoiceVolume(1);
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  it("defaults to not muted", () => {
    expect(isVoiceMuted()).toBe(false);
  });

  it("setVoiceMuted flips the value and persists it", () => {
    setVoiceMuted(true);
    expect(isVoiceMuted()).toBe(true);
    expect(localStorage.getItem("herta.voice.muted")).toBe("1");
    setVoiceMuted(false);
    expect(isVoiceMuted()).toBe(false);
    expect(localStorage.getItem("herta.voice.muted")).toBe("0");
  });

  it("notifies subscribers on change, not on a same-value set", () => {
    let n = 0;
    const unsub = subscribeVoiceMuted(() => {
      n += 1;
    });
    setVoiceMuted(true);
    expect(n).toBe(1);
    setVoiceMuted(true); // same value → no notify
    expect(n).toBe(1);
    setVoiceMuted(false);
    expect(n).toBe(2);
    unsub();
    setVoiceMuted(true);
    expect(n).toBe(2); // unsubscribed
  });

  it("reads the persisted value on load", async () => {
    localStorage.setItem("herta.voice.muted", "1");
    vi.resetModules();
    const fresh = await import("./voice-prefs.js");
    expect(fresh.isVoiceMuted()).toBe(true);
  });

  it("volume defaults to 1, persists, and clamps to 0..1", () => {
    expect(getVoiceVolume()).toBe(1);
    setVoiceVolume(0.6);
    expect(getVoiceVolume()).toBe(0.6);
    expect(localStorage.getItem("herta.voice.volume")).toBe("0.6");
    setVoiceVolume(1.7);
    expect(getVoiceVolume()).toBe(1);
    setVoiceVolume(-0.3);
    expect(getVoiceVolume()).toBe(0);
    setVoiceVolume(Number.NaN);
    expect(getVoiceVolume()).toBe(1); // non-finite → full volume
  });

  it("volume notifies subscribers on change, not on a same-value set", () => {
    let n = 0;
    const unsub = subscribeVoiceVolume(() => {
      n += 1;
    });
    setVoiceVolume(0.4);
    expect(n).toBe(1);
    setVoiceVolume(0.4); // same value → no notify
    expect(n).toBe(1);
    unsub();
    setVoiceVolume(0.9);
    expect(n).toBe(1); // unsubscribed
  });

  it("reads the persisted volume on load, clamped", async () => {
    localStorage.setItem("herta.voice.volume", "0.25");
    vi.resetModules();
    const fresh = await import("./voice-prefs.js");
    expect(fresh.getVoiceVolume()).toBe(0.25);
    localStorage.setItem("herta.voice.volume", "garbage");
    vi.resetModules();
    const fresh2 = await import("./voice-prefs.js");
    expect(fresh2.getVoiceVolume()).toBe(1); // NaN → default
  });
});
