import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserWindow, WebContents } from "electron";
import { beforeEach, expect, it, vi } from "vitest";
import { CMD, EVT } from "../preload/channels.js";
import { PRODUCT_PROFILE } from "../shared/product-profile.js";

const checks = vi.hoisted(() => ({
  createHost: vi.fn(),
  localSynth: vi.fn(),
  modelService: vi.fn(),
  cloudVoice: vi.fn(),
  cloudSynth: vi.fn(),
  switchingSynth: vi.fn(),
  voiceTransport: vi.fn(),
  voiceRoot: vi.fn(),
  fetch: vi.fn(),
  ipcHandle: vi.fn(),
  openPath: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getLocale: () => "zh-CN",
    getPreferredSystemLanguages: () => ["zh-CN"],
  },
  ipcMain: { handle: checks.ipcHandle, removeHandler: vi.fn() },
  dialog: {},
  shell: { openPath: checks.openPath },
  net: { fetch: checks.fetch },
  Notification: {},
  powerSaveBlocker: {},
}));
vi.mock("@herta/app-server", () => ({
  createSessionHost: checks.createHost,
  defaultDirsFor: () => ({ recordDir: "records", canonDir: "canon" }),
  recordTail: () => ({ record: [], start: 0 }),
}));
vi.mock("./key-store.js", () => ({
  readDeepSeekKeyPlain: () => null,
  readMiniMaxKeyPlain: () => "unit-test-only-voice-key",
  readMiniMaxPlanKeyPlain: () => null,
}));
vi.mock("./provider-migration.js", () => ({
  migrateLegacyProvider: vi.fn(async () => ({ status: "not-needed" })),
}));
vi.mock("./provider-settings.js", () => ({
  acquireTurnProviders: vi.fn(() => {
    throw new Error("No configured Provider");
  }),
}));
vi.mock("./settings-ipc.js", () => ({
  registerSettingsHandlers: vi.fn(),
  attentionSettingsOf: () => ({ notifications: false, keepAwake: false }),
}));
vi.mock("./app-global-settings.js", async (load) => ({
  ...(await load<typeof import("./app-global-settings.js")>()),
  // A saved voice preference must not override the personal product profile.
  readGlobalSettings: async () => ({
    realtimeVoice: true,
    voiceEngine: "minimax",
    minimaxVoice: null,
  }),
}));
vi.mock("./app-settings.js", async (load) => ({
  ...(await load<typeof import("./app-settings.js")>()),
  readAppSettings: async () => ({}),
}));
vi.mock("./tts/synthesizer.js", () => ({
  createTtsSynthesizer: checks.localSynth,
  resolveSherpaEntry: vi.fn(),
}));
vi.mock("./tts/voice-model.js", () => ({
  createVoiceModelService: checks.modelService,
}));
vi.mock("./tts/minimax-voice.js", () => ({
  createMiniMaxVoiceService: checks.cloudVoice,
}));
vi.mock("./tts/minimax-synthesizer.js", () => ({
  createMiniMaxSynthesizer: checks.cloudSynth,
}));
vi.mock("./tts/switching-synthesizer.js", () => ({
  createSwitchingSynthesizer: checks.switchingSynth,
}));
vi.mock("./tts/fallback-fetch.js", () => ({
  createFallbackFetch: checks.voiceTransport,
}));
vi.mock("./voice-path.js", () => ({ resolveVoiceRoot: checks.voiceRoot }));

import { appWorkspaceRoot, createSessionService } from "./session-service.js";

beforeEach(() => vi.clearAllMocks());
function trustedWindow() {
  const frame = {
    url: pathToFileURL(join(process.cwd(), "out/renderer/index.html")).href,
  };
  const wc = {
    isDestroyed: () => false,
    send: vi.fn(),
    mainFrame: frame,
  } as unknown as WebContents;
  return { wc, event: { sender: wc, senderFrame: frame } };
}

it("pins verification transcripts and migration roots to the explicit userData profile", () => {
  const beforeArgv = process.argv;
  const beforeRoot = process.env.HERTA_WORKSPACE_ROOT;
  try {
    process.argv = [...beforeArgv, "--herta-verification"];
    process.env.HERTA_WORKSPACE_ROOT =
      "environment-must-not-redirect-verification";
    expect(appWorkspaceRoot()).toBe(process.cwd());
  } finally {
    process.argv = beforeArgv;
    if (beforeRoot === undefined) delete process.env.HERTA_WORKSPACE_ROOT;
    else process.env.HERTA_WORKSPACE_ROOT = beforeRoot;
  }
});

it("pins a verification blank session sandbox to its profile instead of OS home", async () => {
  const beforeArgv = process.argv;
  const createSession = vi.fn(async (_opts: unknown) => undefined);
  checks.createHost.mockReturnValue({
    activeSession: null,
    createSession,
    setPdfPictureTranscription: vi.fn(),
    reapOrphanedProcesses: vi.fn(async () => undefined),
    closeActiveSession: vi.fn(async () => undefined),
    dispose: vi.fn(),
  });
  const { wc, event } = trustedWindow();
  const service = createSessionService(wc, {} as BrowserWindow);
  try {
    process.argv = [...beforeArgv, "--herta-verification"];
    await service.start();
    const listener = checks.ipcHandle.mock.calls.find(
      ([channel]) => channel === CMD.create,
    )?.[1];
    await listener(event, {});
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]?.[0]).toMatchObject({
      backendWorkspace: expect.stringContaining(
        join(process.cwd(), "test-projects"),
      ),
    });
  } finally {
    process.argv = beforeArgv;
    await service.dispose();
  }
});

it("boots the personal session host without constructing voice services or making voice requests", async () => {
  expect(PRODUCT_PROFILE.voice).toBe(false);
  checks.createHost.mockReturnValue({
    activeSession: null,
    setPdfPictureTranscription: vi.fn(),
    reapOrphanedProcesses: vi.fn(async () => undefined),
    closeActiveSession: vi.fn(async () => undefined),
    dispose: vi.fn(),
  });
  const send = vi.fn();
  const wc = { isDestroyed: () => false, send } as unknown as WebContents;
  const service = createSessionService(wc, {} as BrowserWindow);
  await service.start();
  expect(checks.createHost).toHaveBeenCalledTimes(1);
  const config = checks.createHost.mock.calls[0]?.[0];
  expect(config).not.toHaveProperty("speech");
  expect(config).not.toHaveProperty("voiceAssetsDir");
  expect(config.providers.deepseekApiKey).toBe("");
  expect(config.neutralProviders.resolveTurn).toBeTypeOf("function");
  expect(config.dream.enabled).toBe(false);
  expect(send).toHaveBeenCalledWith(EVT.reset, { noSession: true });
  for (const factory of [
    checks.localSynth,
    checks.modelService,
    checks.cloudVoice,
    checks.cloudSynth,
    checks.switchingSynth,
    checks.voiceTransport,
    checks.voiceRoot,
    checks.fetch,
  ]) {
    expect(factory).not.toHaveBeenCalled();
  }
  await service.dispose();
});

it("refuses OS file opening before any path can reach an executable association", async () => {
  const { wc, event } = trustedWindow();
  const service = createSessionService(wc, {} as BrowserWindow);
  const registered = checks.ipcHandle.mock.calls.find(
    ([channel]) => channel === CMD.openWorkspaceFile,
  );
  expect(registered).toBeDefined();
  const listener = registered?.[1];
  for (const file of [
    "run.exe",
    "run.cmd",
    "run.bat",
    "shortcut.lnk",
    "code.ts",
  ]) {
    await expect(listener(event, "unit-session", file)).rejects.toThrow(
      "本轮仅支持应用内只读查看文件，请使用文件预览。",
    );
  }
  expect(checks.openPath).not.toHaveBeenCalled();
  await service.dispose();
});

it("rejects foreign and missing frames before trusted permission handler input is evaluated", async () => {
  const { wc, event } = trustedWindow();
  const service = createSessionService(wc, {} as BrowserWindow);
  const listener = checks.ipcHandle.mock.calls.find(
    ([channel]) => channel === CMD.setWorkbenchPermission,
  )?.[1];
  for (const rejected of [
    {},
    { sender: {}, senderFrame: event.senderFrame },
    { sender: wc, senderFrame: null },
    { sender: wc, senderFrame: { url: event.senderFrame.url } },
  ]) {
    expect(() => listener(rejected, { mode: "full-access" })).toThrow(
      "此窗口来源无权访问任务操作。",
    );
  }
  expect(() => listener(event, { mode: "full-access" })).toThrow(
    "权限选择已过期或不属于当前任务",
  );
  await service.dispose();
});
