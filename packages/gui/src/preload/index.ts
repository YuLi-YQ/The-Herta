import {
  contextBridge,
  type IpcRendererEvent,
  ipcRenderer,
  webUtils,
} from "electron";
import type { HertaBridge } from "../renderer/ipc/bridge-types.js";
import { CMD, EVT } from "./channels.js";

function subscribe<T>(channel: string, cb: (e: T) => void): () => void {
  const handler = (_evt: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const bridge: HertaBridge = {
  promptPlugins: (input) => ipcRenderer.invoke(CMD.promptPlugins, input),
  executablePlugins: (input) => ipcRenderer.invoke(CMD.executablePlugins, input),
  readHertaChatImage: (chatId, messageId, index) => ipcRenderer.invoke("herta-chat:image", chatId, messageId, index),
  getHertaChat: () => ipcRenderer.invoke("herta-chat:snapshot"),
  sendHertaChat: (input) => ipcRenderer.invoke("herta-chat:send", input),
  stopHertaChat: () => ipcRenderer.invoke("herta-chat:stop"),
  manageHertaChat: (action) => ipcRenderer.invoke("herta-chat:manage", action),
  draftChatContext: (input) => ipcRenderer.invoke(CMD.draftChatContext, input),
  cancelChatContextDraft: (input) => ipcRenderer.invoke(CMD.cancelChatContextDraft, input),
  getSessionCompact: (id) => ipcRenderer.invoke(CMD.getSessionCompact, id),
  updateSessionCompact: (id, revision, action) => ipcRenderer.invoke(CMD.updateSessionCompact, id, revision, action),
  getSessionGoal: (id) => ipcRenderer.invoke(CMD.getSessionGoal, id),
  getSessionPlan: (id) => ipcRenderer.invoke(CMD.getSessionPlan, id),
  updateSessionPlan: (id, revision, action) =>
    ipcRenderer.invoke(CMD.updateSessionPlan, id, revision, action),
  updateSessionGoal: (id, revision, action) => ipcRenderer.invoke(CMD.updateSessionGoal, id, revision, action),
  getChatGoal: (id) => ipcRenderer.invoke(CMD.getChatGoal, id),
  updateChatGoal: (id, revision, action) => ipcRenderer.invoke(CMD.updateChatGoal, id, revision, action),
  parseChatFile: (name, bytes, job) =>
    ipcRenderer.invoke("herta-chat:parse-file", name, bytes, job),
  cancelChatFile: (job) => ipcRenderer.invoke("herta-chat:cancel-file", job),
  saveChatFile: (name, content) => ipcRenderer.invoke("herta-chat:save-file", name, content),
  getProjectNavigation: () => ipcRenderer.invoke(CMD.getProjectNavigation),
  updateProjectNavigation: (input) =>
    ipcRenderer.invoke(CMD.updateProjectNavigation, input),
  getWorkbenchPermission: () => ipcRenderer.invoke(CMD.getWorkbenchPermission),
  setWorkbenchPermission: (input) =>
    ipcRenderer.invoke(CMD.setWorkbenchPermission, input),
  getProviderSettings: () => ipcRenderer.invoke(CMD.getProviderSettings),
  getProviderReadiness: (sessionId) =>
    ipcRenderer.invoke(CMD.getProviderReadiness, sessionId),
  getPendingUserInput: (sessionId) =>
    ipcRenderer.invoke(CMD.getPendingUserInput, sessionId),
  getRoundSummaries: (sessionId) =>
    ipcRenderer.invoke(CMD.getRoundSummaries, sessionId),
  readRoundFile: (sessionId, roundId, fileId) =>
    ipcRenderer.invoke(CMD.readRoundFile, sessionId, roundId, fileId),
  getTaskMetrics: (sessionId) =>
    ipcRenderer.invoke(CMD.getTaskMetrics, sessionId),
  answerUserInput: (answer) => ipcRenderer.invoke(CMD.answerUserInput, answer),
  discoverProviderModels: (input) =>
    ipcRenderer.invoke(CMD.discoverProviderModels, input),
  validateProviderModel: (input) =>
    ipcRenderer.invoke(CMD.validateProviderModel, input),
  resetImageChecks: () => ipcRenderer.invoke(CMD.resetImageChecks),
  saveProvider: (input) => ipcRenderer.invoke(CMD.saveProvider, input),
  deleteProvider: (id) => ipcRenderer.invoke(CMD.deleteProvider, id),
  setProviderBindings: (input) =>
    ipcRenderer.invoke(CMD.setProviderBindings, input),
  platform: process.platform,
  submitText: (text, stagedImageIds, expectedSessionId) =>
    ipcRenderer.invoke(CMD.submitText, text, stagedImageIds, expectedSessionId),
  interrupt: (turnId) => ipcRenderer.invoke(CMD.interrupt, turnId),
  steerText: (text) => ipcRenderer.invoke(CMD.steerText, text),
  continueInterrupted: () => ipcRenderer.invoke(CMD.continueInterrupted),
  rewindLastTurn: (sessionId) =>
    ipcRenderer.invoke(CMD.rewindLastTurn, sessionId),
  maybePlayEasterEgg: () => ipcRenderer.invoke(CMD.maybePlayEasterEgg),
  listSessions: () => ipcRenderer.invoke(CMD.list),
  searchSessions: (query) => ipcRenderer.invoke(CMD.search, query),
  recordSlice: (sessionId, before, count) =>
    ipcRenderer.invoke(CMD.recordSlice, sessionId, before, count),
  openSession: (id, navigation) => ipcRenderer.invoke(CMD.open, id, navigation),
  createSession: (opts, navigation) =>
    ipcRenderer.invoke(CMD.create, opts, navigation),
  deleteSession: (id) => ipcRenderer.invoke(CMD.deleteSession, id),
  renameSession: (id, title) =>
    ipcRenderer.invoke(CMD.renameSession, id, title),
  readSessionForExport: (id) =>
    ipcRenderer.invoke(CMD.readSessionForExport, id),
  saveSessionExport: (fileName, markdown) =>
    ipcRenderer.invoke(CMD.saveSessionExport, fileName, markdown),
  resolveApproval: (opts) => ipcRenderer.invoke(CMD.resolveApproval, opts),
  listCommandRules: () => ipcRenderer.invoke(CMD.listCommandRules),
  removeCommandRule: (display) =>
    ipcRenderer.invoke(CMD.removeCommandRule, display),
  getWorkspaceTrust: () => ipcRenderer.invoke(CMD.getWorkspaceTrust),
  setWorkspaceTrust: (value) =>
    ipcRenderer.invoke(CMD.setWorkspaceTrust, value),
  resyncRecord: () => ipcRenderer.invoke(CMD.resyncRecord),
  requestSessionSync: () => ipcRenderer.invoke(CMD.requestSync),
  refreshRepo: () => ipcRenderer.invoke(CMD.refreshRepo),
  checkForUpdate: () => ipcRenderer.invoke(CMD.updateCheck),
  restartAndInstall: () => ipcRenderer.invoke(CMD.updateRestart),
  getUpdateState: () => ipcRenderer.invoke(CMD.updateStatus),
  getAppVersion: () => ipcRenderer.invoke(CMD.appVersion),
  getSystemInfo: () => ipcRenderer.invoke(CMD.systemInfo),
  onUpdate: (cb) => subscribe(EVT.update, cb),
  pickWorkspace: () => ipcRenderer.invoke(CMD.pickWorkspace),
  setWorkspace: (sessionId, path) =>
    ipcRenderer.invoke(CMD.setWorkspace, sessionId, path),
  resetWorkspace: (sessionId) =>
    ipcRenderer.invoke(CMD.resetWorkspace, sessionId),
  pickAttachments: () => ipcRenderer.invoke(CMD.pickAttachments),
  attachFiles: (sessionId, paths, options) =>
    ipcRenderer.invoke(CMD.attachFiles, sessionId, paths, options),
  removeAttachment: (sessionId, path) =>
    ipcRenderer.invoke(CMD.removeAttachment, sessionId, path),
  setPictureModelUse: (sessionId, targets, use) =>
    ipcRenderer.invoke(CMD.setPictureModelUse, sessionId, targets, use),
  stageImages: (sessionId, inputs, job) =>
    ipcRenderer.invoke(CMD.stageImages, sessionId, inputs, job),
  cancelStaging: (sessionId, job) =>
    ipcRenderer.invoke(CMD.cancelStaging, sessionId, job),
  unstageImage: (sessionId, id) =>
    ipcRenderer.invoke(CMD.unstageImage, sessionId, id),
  resetPendingImages: (sessionId) =>
    ipcRenderer.invoke(CMD.resetPendingImages, sessionId),
  prepareStagedImages: (sessionId, ids) =>
    ipcRenderer.invoke(CMD.prepareStagedImages, sessionId, ids),
  readWorkspaceFile: (sessionId, path) =>
    ipcRenderer.invoke(CMD.readWorkspaceFile, sessionId, path),
  listWorkspaceFiles: (sessionId) =>
    ipcRenderer.invoke(CMD.listWorkspaceFiles, sessionId),
  readWorkspaceBytes: (sessionId, path) =>
    ipcRenderer.invoke(CMD.readWorkspaceBytes, sessionId, path),
  readWorkspaceCommit: (sessionId, ref) =>
    ipcRenderer.invoke(CMD.readWorkspaceCommit, sessionId, ref),
  readWorkspaceDiff: (sessionId, path) =>
    ipcRenderer.invoke(CMD.readWorkspaceDiff, sessionId, path),
  readWorkspaceLog: (sessionId, opts) =>
    ipcRenderer.invoke(CMD.readWorkspaceLog, sessionId, opts),
  readWorkspaceBranches: (sessionId) =>
    ipcRenderer.invoke(CMD.readWorkspaceBranches, sessionId),
  openWorkspaceFile: (sessionId, path) =>
    ipcRenderer.invoke(CMD.openWorkspaceFile, sessionId, path),
  // Electron 43 removed `File.path`, and this preload is CJS + sandboxed
  // (main/index.ts:266 records why it must stay that way), so a dropped
  // file's real path is only reachable through webUtils here. The renderer
  // gets a path string and never a File handle.
  pathForFile: (file) => webUtils.getPathForFile(file),
  getDreamConfig: () => ipcRenderer.invoke(CMD.getDreamConfig),
  setDreamConfig: (cfg) => ipcRenderer.invoke(CMD.setDreamConfig, cfg),
  getBackendConfig: () => ipcRenderer.invoke(CMD.getBackendConfig),
  setBackendConfig: (cfg) => ipcRenderer.invoke(CMD.setBackendConfig, cfg),
  getModelConfig: () => ipcRenderer.invoke(CMD.getModelConfig),
  setModelConfig: (cfg) => ipcRenderer.invoke(CMD.setModelConfig, cfg),
  getLocale: () => ipcRenderer.invoke(CMD.getLocale),
  setLocale: (locale) => ipcRenderer.invoke(CMD.setLocale, locale),
  getInteractionLanguage: () => ipcRenderer.invoke(CMD.getInteractionLanguage),
  setInteractionLanguage: (choice) =>
    ipcRenderer.invoke(CMD.setInteractionLanguage, choice),
  getCloseToTray: () => ipcRenderer.invoke(CMD.getCloseToTray),
  setCloseToTray: (enabled) => ipcRenderer.invoke(CMD.setCloseToTray, enabled),
  getAttention: () => ipcRenderer.invoke(CMD.getAttention),
  setAttention: (prefs) => ipcRenderer.invoke(CMD.setAttention, prefs),
  getAutoUpdate: () => ipcRenderer.invoke(CMD.getAutoUpdate),
  setAutoUpdate: (enabled) => ipcRenderer.invoke(CMD.setAutoUpdate, enabled),
  getTheme: () => ipcRenderer.invoke(CMD.getTheme),
  setTheme: (theme) => ipcRenderer.invoke(CMD.setTheme, theme),
  // The desktop draws the 3D device card (ADR 0057); whether THIS machine's
  // GPU can is the renderer's probe. No setting since 2026-10-01.
  getDeviceScene: () => Promise.resolve(true),
  getPdfPictureTranscripts: () =>
    ipcRenderer.invoke(CMD.getPdfPictureTranscripts),
  setPdfPictureTranscripts: (enabled) =>
    ipcRenderer.invoke(CMD.setPdfPictureTranscripts, enabled),
  getRealtimeVoice: () => ipcRenderer.invoke(CMD.getRealtimeVoice),
  setRealtimeVoice: (enabled) =>
    ipcRenderer.invoke(CMD.setRealtimeVoice, enabled),
  downloadVoiceModel: () => ipcRenderer.invoke(CMD.downloadVoiceModel),
  cancelVoiceModelDownload: () =>
    ipcRenderer.invoke(CMD.cancelVoiceModelDownload),
  removeVoiceModel: () => ipcRenderer.invoke(CMD.removeVoiceModel),
  onVoiceModel: (cb) => subscribe(EVT.voiceModel, cb),
  setVoiceEngine: (engine) => ipcRenderer.invoke(CMD.setVoiceEngine, engine),
  getMiniMaxKeyStatus: () => ipcRenderer.invoke(CMD.getMiniMaxKeyStatus),
  setMiniMaxKey: (key) => ipcRenderer.invoke(CMD.setMiniMaxKey, key),
  clearMiniMaxKey: () => ipcRenderer.invoke(CMD.clearMiniMaxKey),
  openExternal: (url) => ipcRenderer.invoke(CMD.openExternal, url),
  getMiniMaxPlanKeyStatus: () =>
    ipcRenderer.invoke(CMD.getMiniMaxPlanKeyStatus),
  setMiniMaxPlanKey: (key) => ipcRenderer.invoke(CMD.setMiniMaxPlanKey, key),
  clearMiniMaxPlanKey: () => ipcRenderer.invoke(CMD.clearMiniMaxPlanKey),
  prepareMiniMaxVoice: () => ipcRenderer.invoke(CMD.prepareMiniMaxVoice),
  onMiniMaxVoice: (cb) => subscribe(EVT.voiceMinimax, cb),
  onMiniMaxSpeech: (cb) => subscribe(EVT.voiceMinimaxSpeech, cb),
  getDeepSeekKeyStatus: () => ipcRenderer.invoke(CMD.getDeepSeekKeyStatus),
  setDeepSeekKey: (key) => ipcRenderer.invoke(CMD.setDeepSeekKey, key),
  clearDeepSeekKey: () => ipcRenderer.invoke(CMD.clearDeepSeekKey),
  windowMinimize: () => ipcRenderer.send(CMD.windowMinimize),
  windowToggleMaximize: () => ipcRenderer.send(CMD.windowToggleMaximize),
  windowClose: () => ipcRenderer.send(CMD.windowClose),
  windowIsMaximized: () => ipcRenderer.invoke(CMD.windowIsMaximized),
  onWindowMaximized: (cb) => subscribe(EVT.windowMaximized, cb),
  windowIsFullScreen: () => ipcRenderer.invoke(CMD.windowIsFullScreen),
  onWindowFullScreen: (cb) => subscribe(EVT.windowFullScreen, cb),
  onOpenSettings: (cb) => subscribe(EVT.openSettings, () => cb()),
  onWorkspace: (cb) => subscribe(EVT.workspace, cb),
  onRepo: (cb) => subscribe(EVT.repo, cb),
  onResume: (cb) => subscribe(EVT.resume, cb),
  onLive: (cb) => subscribe(EVT.live, cb),
  onAttachProgress: (cb) => subscribe(EVT.attachProgress, cb),
  onRecord: (cb) => subscribe(EVT.record, cb),
  onOverlay: (cb) => subscribe(EVT.overlay, cb),
  onSpeech: (cb) => subscribe(EVT.speech, cb),
  onAgent: (cb) => subscribe(EVT.agent, cb),
  onTurn: (cb) => subscribe(EVT.turn, cb),
  onReset: (cb) => subscribe(EVT.reset, cb),
  onTitle: (cb) => subscribe(EVT.title, cb),
  onSessionDeleted: (cb) => subscribe(EVT.sessionDeleted, cb),
  onNavBlocked: (cb) => subscribe(EVT.navBlocked, cb),
  onVoice: (cb) => subscribe(EVT.voice, cb),
};

contextBridge.exposeInMainWorld("herta", bridge);

