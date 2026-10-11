import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceSettingsState } from "./settings-ipc.js";

/**
 * The Settings rows' IPC door, driven with a fake registrar (ADR 0042 §7c:
 * the 实时语音 toggle). `electron` is mocked to the one call the handlers
 * make at this depth — `app.getPath("userData")` — into a temp dir.
 */
const userData = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => userData.dir, isPackaged: false },
}));

const { CMD } = await import("../preload/channels.js");
const { registerSettingsHandlers } = await import("./settings-ipc.js");

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

afterEach(() => {
  if (userData.dir.length > 0) {
    rmSync(userData.dir, { recursive: true, force: true });
    userData.dir = "";
  }
});

describe("settings IPC — personal desktop feature policy", () => {
  it.each([
    CMD.setRealtimeVoice,
    CMD.setVoiceEngine,
    CMD.downloadVoiceModel,
    CMD.cancelVoiceModelDownload,
    CMD.removeVoiceModel,
    CMD.setMiniMaxKey,
    CMD.clearMiniMaxKey,
    CMD.setMiniMaxPlanKey,
    CMD.clearMiniMaxPlanKey,
    CMD.prepareMiniMaxVoice,
  ])("denies %s without storing settings, contacting services or starting speech", async (channel) => {
    userData.dir = mkdtempSync(join(tmpdir(), "herta-settings-"));
    const handlers = new Map<string, Handler>();
    const stopSpeech = vi.fn();
    const voice: VoiceSettingsState = {
      synthesizer: null,
      voiceModel: null,
      minimaxVoice: null,
      engine: "local",
      realtimeEnabled: true,
      minimaxFetch: (async () => new Response("")) as never,
      anyMiniMaxKey: () => false,
      minimaxRefusal: () => null,
      stopSpeech,
    };
    registerSettingsHandlers({
      handle: ((channel: string, fn: Handler) => {
        handlers.set(channel, fn);
      }) as never,
      hooks: {},
      host: () => null,
      workspaceRoot: () => userData.dir,
      voice,
    });
    expect(voice.realtimeEnabled).toBe(false);
    const handler = handlers.get(channel);
    expect(handler).toBeDefined();
    await expect(handler?.(null, true)).rejects.toThrow("不提供语音");
    expect(stopSpeech).not.toHaveBeenCalled();
    expect(voice.realtimeEnabled).toBe(false);
    expect(existsSync(join(userData.dir, "settings.json"))).toBe(false);
  });

  it("reports disabled voice and update state even when old settings request both", async () => {
    userData.dir = mkdtempSync(join(tmpdir(), "herta-settings-"));
    const saved = JSON.stringify({ realtimeVoice: true, autoUpdate: true });
    writeFileSync(join(userData.dir, "settings.json"), saved);
    const handlers = new Map<string, Handler>();
    const onAutoUpdateChanged = vi.fn();
    const voiceTouched = vi.fn(() => {
      throw new Error("voice service must not be accessed");
    });
    registerSettingsHandlers({
      handle: ((channel: string, fn: Handler) =>
        handlers.set(channel, fn)) as never,
      hooks: { onAutoUpdateChanged },
      host: () => null,
      workspaceRoot: () => userData.dir,
      voice: {
        synthesizer: { status: voiceTouched } as never,
        voiceModel: { state: voiceTouched } as never,
        minimaxVoice: { state: voiceTouched } as never,
        engine: "minimax",
        realtimeEnabled: true,
        minimaxFetch: voiceTouched as never,
        anyMiniMaxKey: voiceTouched,
        minimaxRefusal: voiceTouched,
        stopSpeech: voiceTouched,
      },
    });
    expect(await handlers.get(CMD.getRealtimeVoice)?.(null)).toMatchObject({
      enabled: false,
      bundle: false,
      runtime: false,
      engine: "local",
      model: { phase: "absent", totalBytes: 0 },
    });
    expect(await handlers.get(CMD.getMiniMaxKeyStatus)?.(null)).toEqual({
      set: false,
      hint: null,
      encrypted: false,
    });
    expect(await handlers.get(CMD.getMiniMaxPlanKeyStatus)?.(null)).toEqual({
      set: false,
      hint: null,
      encrypted: false,
    });
    expect(await handlers.get(CMD.getAutoUpdate)?.(null)).toBe(false);
    await expect(handlers.get(CMD.setAutoUpdate)?.(null, true)).rejects.toThrow(
      "禁用自动更新",
    );
    expect(voiceTouched).not.toHaveBeenCalled();
    expect(onAutoUpdateChanged).not.toHaveBeenCalled();
    expect(readFileSync(join(userData.dir, "settings.json"), "utf8")).toBe(
      saved,
    );
  });
});

describe("settings IPC — Dream says what the running app has (dream review 2026-09-22, finding 20)", () => {
  it("answers the saved flag AND the running one; before bootstrap it says only the saved one", async () => {
    userData.dir = mkdtempSync(join(tmpdir(), "herta-settings-"));
    const handlers = new Map<string, Handler>();
    let running: boolean | undefined;
    registerSettingsHandlers({
      handle: ((channel: string, fn: Handler) => {
        handlers.set(channel, fn);
      }) as never,
      hooks: {},
      host: () => null,
      workspaceRoot: () => userData.dir,
      voice: {
        synthesizer: null,
        voiceModel: null,
        minimaxVoice: null,
        engine: "local",
        realtimeEnabled: false,
        minimaxFetch: (async () => new Response("")) as never,
        anyMiniMaxKey: () => false,
        minimaxRefusal: () => null,
        stopSpeech: () => {},
      },
      dreamRunning: () => running,
    });
    const get = handlers.get(CMD.getDreamConfig);
    const set = handlers.get(CMD.setDreamConfig);
    expect(await get?.(null)).toEqual({ enabled: false });
    running = false; // the host bootstrapped with Dream off
    await set?.(null, { enabled: true });
    expect(await get?.(null)).toEqual({ enabled: true, running: false });
  });
});

describe("settings IPC — PDF picture transcription (2026-10-01)", () => {
  it("defaults on; a write persists, reaches the running host at once, and ignores anything but a boolean", async () => {
    userData.dir = mkdtempSync(join(tmpdir(), "herta-settings-"));
    const handlers = new Map<string, Handler>();
    const setPdfPictureTranscription = vi.fn();
    registerSettingsHandlers({
      handle: ((channel: string, fn: Handler) => {
        handlers.set(channel, fn);
      }) as never,
      hooks: {},
      host: () => ({ setPdfPictureTranscription }) as never,
      workspaceRoot: () => userData.dir,
      voice: {
        synthesizer: null,
        voiceModel: null,
        minimaxVoice: null,
        engine: "local",
        realtimeEnabled: false,
        minimaxFetch: (async () => new Response("")) as never,
        anyMiniMaxKey: () => false,
        minimaxRefusal: () => null,
        stopSpeech: () => {},
      },
    });
    const get = handlers.get(CMD.getPdfPictureTranscripts);
    const set = handlers.get(CMD.setPdfPictureTranscripts);
    expect(await get?.(null)).toBe(true);

    await set?.(null, false);
    expect(await get?.(null)).toBe(false);
    expect(setPdfPictureTranscription).toHaveBeenLastCalledWith(false);

    await set?.(null, "yes");
    expect(setPdfPictureTranscription).toHaveBeenCalledTimes(1);
    expect(await get?.(null)).toBe(false);
  });
});

describe("settings IPC — attention (ADR 0072 §1)", () => {
  it("both default on; a write carries either one, ignores anything but a boolean, and tells main both values", async () => {
    userData.dir = mkdtempSync(join(tmpdir(), "herta-settings-"));
    const handlers = new Map<string, Handler>();
    const changed = vi.fn();
    registerSettingsHandlers({
      handle: ((channel: string, fn: Handler) => {
        handlers.set(channel, fn);
      }) as never,
      hooks: { onAttentionChanged: changed },
      host: () => null,
      workspaceRoot: () => userData.dir,
      voice: {
        synthesizer: null,
        voiceModel: null,
        minimaxVoice: null,
        engine: "local",
        realtimeEnabled: false,
        minimaxFetch: (async () => new Response("")) as never,
        anyMiniMaxKey: () => false,
        minimaxRefusal: () => null,
        stopSpeech: () => {},
      },
    });
    const get = handlers.get(CMD.getAttention);
    const set = handlers.get(CMD.setAttention);
    expect(await get?.(null)).toEqual({ notifications: true, keepAwake: true });

    await set?.(null, { keepAwake: false });
    expect(await get?.(null)).toEqual({
      notifications: true,
      keepAwake: false,
    });
    expect(changed).toHaveBeenLastCalledWith({
      notifications: true,
      keepAwake: false,
    });

    await set?.(null, { notifications: "no", keepAwake: 1 });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await get?.(null)).toEqual({
      notifications: true,
      keepAwake: false,
    });
  });
});
