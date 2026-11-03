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
  recordRefused: vi.fn(),
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
  getProviderReadiness: () => ({ ready: true }),
  ProviderConfigurationError: class extends Error {},
  acquireTurnProviders: vi.fn(() => {
    throw new Error("No configured Provider");
  }),
  recordImageRequestRefused: checks.recordRefused,
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
  // R110 (F06): the workbench's refused requests with pictures reach the record beside the settings.
  const refused = { providerId: "p", providerRevision: 2, modelId: "m", status: 400, surface: "workbench" };
  config.neutralProviders.onImageRequestRefused(refused);
  expect(checks.recordRefused).toHaveBeenCalledWith(refused);
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

it("R90 rejects a submit addressed to a different session before invoking the active one", async () => {
  const host = {
    activeSession: null as unknown,
    setPdfPictureTranscription: vi.fn(),
    reapOrphanedProcesses: vi.fn(async () => undefined),
    closeActiveSession: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  checks.createHost.mockReturnValue(host);
  const { wc, event } = trustedWindow();
  const service = createSessionService(wc, {} as BrowserWindow);
  try {
    await service.start();
    const submit = vi.fn(async () => ({ turnId: "unexpected" }));
    host.activeSession = { sessionId: "new-session", submitText: submit, record: [], stagedImageList: [{ id: "image-1" }] };
    const listener = checks.ipcHandle.mock.calls.find(([channel]) => channel === CMD.submitText)?.[1];
    const result = await listener(event, "old draft", undefined, "old-session");
    expect(result).toMatchObject({ failure: { stage: "configuration", message: expect.stringContaining("任务已切换") } });
    expect(submit).not.toHaveBeenCalled();
    for (const invalid of ["", "../other", 42, null]) {
      await expect(listener(event, "draft", undefined, invalid)).rejects.toThrow("任务输入格式");
    }
    expect(submit).not.toHaveBeenCalled();
    const accepted = await listener(event, "correct draft", ["image-1"], "new-session");
    expect(accepted).toEqual({ turnId: "unexpected" });
    expect(submit).toHaveBeenCalledExactlyOnceWith("correct draft", { stagedImageIds: ["image-1"] });
  } finally {
    host.activeSession = null;
    await service.dispose();
  }
});



it("R93 refuses missing image handles before sending any part of a message", async () => {
  const host = { activeSession: null as unknown, setPdfPictureTranscription: vi.fn(), reapOrphanedProcesses: vi.fn(async () => undefined), closeActiveSession: vi.fn(async () => undefined), dispose: vi.fn() };
  checks.createHost.mockReturnValue(host);
  const { wc, event } = trustedWindow();
  const service = createSessionService(wc, {} as BrowserWindow);
  try {
    await service.start();
    const submit = vi.fn(async () => ({ turnId: "unexpected" }));
    host.activeSession = { sessionId: "s", record: [], stagedImageList: [{ id: "valid" }], submitText: submit };
    const listener = checks.ipcHandle.mock.calls.find(([channel]) => channel === CMD.submitText)?.[1];
    const result = await listener(event, "picture question", ["valid", "lost"], "s");
    expect(result).toMatchObject({ failure: { stage: "configuration", message: expect.stringContaining("图片暂存已失效") } });
    expect(submit).not.toHaveBeenCalled();
    submit.mockImplementationOnce(async () => { throw Object.assign(new Error("missing copy"), { code: "image-unreadable" }); });
    const failedRead = await listener(event, "restore image", ["valid"], "s");
    expect(failedRead).toMatchObject({ failure: { code: "image-unreadable", stage: "configuration" } });
  } finally { host.activeSession = null; await service.dispose(); }
});



it("R98 binds the manifest reset to the active task and names an unrestorable picture as an attachment problem", async () => {
  const host = { activeSession: null as unknown, setPdfPictureTranscription: vi.fn(), reapOrphanedProcesses: vi.fn(async () => undefined), closeActiveSession: vi.fn(async () => undefined), dispose: vi.fn() };
  checks.createHost.mockReturnValue(host);
  const { wc, event } = trustedWindow();
  const service = createSessionService(wc, {} as BrowserWindow);
  try {
    await service.start();
    const reset = vi.fn(async () => ({ ok: true as const, backup: "s.json.damaged-x" }));
    const submit = vi.fn(async () => { throw Object.assign(new Error("missing copy"), { code: "image-unreadable" }); });
    host.activeSession = { sessionId: "s", record: [], stagedImageList: [{ id: "valid" }], submitText: submit, resetPendingImages: reset };
    const resetListener = checks.ipcHandle.mock.calls.find(([channel]) => channel === CMD.resetPendingImages)?.[1];
    expect(await resetListener(event, "other")).toEqual({ ok: false, reason: "failed" });
    expect(await resetListener(event, 42)).toEqual({ ok: false, reason: "failed" });
    expect(reset).not.toHaveBeenCalled();
    expect(await resetListener(event, "s")).toEqual({ ok: true, backup: "s.json.damaged-x" });
    const listener = checks.ipcHandle.mock.calls.find(([channel]) => channel === CMD.submitText)?.[1];
    const failed = await listener(event, "restore image", ["valid"], "s");
    expect(failed).toMatchObject({ failure: { code: "image-unreadable", stage: "configuration", action: "attachment", message: expect.stringContaining("图片缺失") } });
  } finally { host.activeSession = null; await service.dispose(); }
});

it("R98 reads restored pictures for the active task only, with bounded ids", async () => {
  const host = { activeSession: null as unknown, setPdfPictureTranscription: vi.fn(), reapOrphanedProcesses: vi.fn(async () => undefined), closeActiveSession: vi.fn(async () => undefined), dispose: vi.fn() };
  checks.createHost.mockReturnValue(host);
  const { wc, event } = trustedWindow();
  const service = createSessionService(wc, {} as BrowserWindow);
  try {
    await service.start();
    const prepare = vi.fn(async (ids: readonly string[]) => ids.filter((id) => id === "lost"));
    host.activeSession = { sessionId: "s", record: [], stagedImageList: [], prepareStagedImages: prepare };
    const listener = checks.ipcHandle.mock.calls.find(([channel]) => channel === CMD.prepareStagedImages)?.[1];
    for (const ids of [undefined, "kept", [1], [""], ["a", "b", "c", "d", "e", "f"], ["x".repeat(129)]])
      expect(await listener(event, "s", ids)).toEqual({ ok: false });
    expect(await listener(event, "other", ["kept"])).toEqual({ ok: false });
    expect(prepare).not.toHaveBeenCalled();
    expect(await listener(event, "s", ["kept", "lost"])).toEqual({ ok: true, unreadable: ["lost"] });
  } finally { host.activeSession = null; await service.dispose(); }
});

it("R100 asks for all-or-nothing only on request, returns the missing paths, and names a move in progress", async () => {
  const host = { activeSession: null as unknown, setPdfPictureTranscription: vi.fn(), reapOrphanedProcesses: vi.fn(async () => undefined), closeActiveSession: vi.fn(async () => undefined), dispose: vi.fn() };
  checks.createHost.mockReturnValue(host);
  const { wc, event } = trustedWindow();
  const service = createSessionService(wc, {} as BrowserWindow);
  try {
    await service.start();
    const attach = vi.fn(async (_paths: readonly string[], _progress?: unknown, opts?: { requireAll?: boolean }) =>
      opts?.requireAll ? { ok: false as const, reason: "missing" as const, missing: ["C:\\gone.md"] } : { ok: false as const, reason: "workspace_changing" as const });
    const stage = vi.fn(async () => ({ ok: false as const, reason: "workspace_changing" as const }));
    host.activeSession = { sessionId: "s", record: [], stagedImageList: [], attachFiles: attach, stageImages: stage };
    const attachListener = checks.ipcHandle.mock.calls.find(([channel]) => channel === CMD.attachFiles)?.[1];
    expect(await attachListener(event, "s", ["C:\\gone.md"], { requireAll: true })).toEqual({ ok: false, message: "missing files", missing: ["C:\\gone.md"] });
    expect(attach.mock.calls[0]?.[2]).toEqual({ requireAll: true });
    for (const loose of [undefined, { requireAll: "yes" }, "requireAll", null])
      expect(await attachListener(event, "s", ["C:\\a.md"], loose)).toEqual({ ok: false, message: "workspace changing" });
    expect(attach.mock.calls.slice(1).every((call) => call[2] === undefined)).toBe(true);
    const stageListener = checks.ipcHandle.mock.calls.find(([channel]) => channel === CMD.stageImages)?.[1];
    expect(await stageListener(event, "s", [{ path: "C:\\a.png" }])).toEqual({ ok: false, message: "workspace changing" });
  } finally { host.activeSession = null; await service.dispose(); }
});

it("R116 binds a picture's model use to the active task, checks the request's shape first, and passes on the session's answer", async () => {
  const host = {
    activeSession: null as unknown,
    setPdfPictureTranscription: vi.fn(),
    reapOrphanedProcesses: vi.fn(async () => undefined),
    closeActiveSession: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  checks.createHost.mockReturnValue(host);
  const { wc, event } = trustedWindow();
  const service = createSessionService(wc, {} as BrowserWindow);
  try {
    await service.start();
    const change = vi.fn(
      async (
        _targets: readonly { index: number; path: string }[],
        _use: "stop" | "send",
      ) =>
        ({ ok: true as const, changed: 2 }) as
          | { ok: true; changed: number }
          | { ok: false; reason: "turn_in_progress" | "not_found" | "invalid" },
    );
    host.activeSession = {
      sessionId: "s",
      record: [],
      stagedImageList: [],
      setPictureModelUse: change,
    };
    const listener = checks.ipcHandle.mock.calls.find(
      ([channel]) => channel === CMD.setPictureModelUse,
    )?.[1];
    const target = { index: 3, path: ".herta/attachments/s/a.png" };
    expect(await listener(event, "other", [target], "stop")).toEqual({
      ok: false,
      reason: "no_session",
    });
    expect(await listener(event, 42, [target], "stop")).toEqual({
      ok: false,
      reason: "no_session",
    });
    const many = Array.from({ length: 33 }, (_, index) => ({
      index,
      path: target.path,
    }));
    const malformed: [unknown, unknown][] = [
      [undefined, "stop"],
      [target, "stop"],
      ["a.png", "stop"],
      [[], "stop"],
      [many, "stop"],
      [[null], "stop"],
      [[{ index: -1, path: target.path }], "stop"],
      [[{ index: 1.5, path: target.path }], "stop"],
      [[{ index: "3", path: target.path }], "stop"],
      [[{ index: 2 ** 53, path: target.path }], "stop"],
      [[{ index: 3, path: "" }], "stop"],
      [[{ index: 3, path: "p".repeat(4097) }], "stop"],
      [[{ index: 3 }], "stop"],
      [[target], "pause"],
      [[target], undefined],
    ];
    for (const [targets, use] of malformed)
      expect(await listener(event, "s", targets, use)).toEqual({
        ok: false,
        reason: "invalid",
      });
    expect(change).not.toHaveBeenCalled();
    // Only the index and path go on: anything else the window sends is dropped.
    expect(
      await listener(
        event,
        "s",
        [
          { ...target, extra: "dropped" },
          { index: 4, path: target.path },
        ],
        "stop",
      ),
    ).toEqual({ ok: true, changed: 2 });
    expect(change).toHaveBeenCalledExactlyOnceWith(
      [target, { index: 4, path: target.path }],
      "stop",
    );
    expect(await listener(event, "s", many.slice(0, 32), "send")).toEqual({
      ok: true,
      changed: 2,
    });
    for (const reason of [
      "turn_in_progress",
      "not_found",
      "invalid",
    ] as const) {
      change.mockResolvedValueOnce({ ok: false, reason });
      expect(await listener(event, "s", [target], "send")).toEqual({
        ok: false,
        reason,
      });
    }
    host.activeSession = { sessionId: "s", record: [], stagedImageList: [] };
    expect(await listener(event, "s", [target], "send")).toEqual({
      ok: false,
      reason: "unavailable",
    });
  } finally {
    host.activeSession = null;
    await service.dispose();
  }
});
