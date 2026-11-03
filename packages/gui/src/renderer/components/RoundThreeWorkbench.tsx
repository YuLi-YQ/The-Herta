import { PluginDeliverablesPanel } from "./Plugins/PluginDeliverablesPanel.js";
import { readPendingDocs, writePendingDocs, type PendingDoc, type PendingDocsIssue } from "../lib/pending-documents.js";
import { readAttachIssues, writeAttachIssues, type AttachIssue, type AttachIssuesProblem } from "../lib/pending-attach-issues.js";
import { PromptActionPicker } from "./Plugins/PromptActionPicker.js";
import { ModeTabs } from "./ModeTabs.js";
import { HertaChat } from "./HertaChat.js";
import { Icon } from "./Icon.js";
import welcomePortrait from "../assets/great-herta-welcome-v1.png";
import { WorkbenchSearch } from "./WebSearch.js";
import { ComposerModelPicker } from "./ComposerModelPicker.js";
import type {
  RoundFileContent,
  RoundMetrics,
  RoundSummary,
} from "@herta/app-server";
import type { PermissionMode } from "@herta/core";
import {
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type SetStateAction,
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { safeProviderFailure } from "../../shared/provider-failure.js";
import type {
  ProviderReadiness,
  WorkbenchFailure,
} from "../../shared/provider-settings-ipc.js";
import type {
  NavigationMutation,
  PendingUserInput,
  ProjectNavigationView,
  WorkbenchPermission,
} from "../../shared/workbench-ipc.js";
import { useHertaBridge } from "../context/HertaBridgeContext.js";
import { useActiveSession } from "../hooks/useActiveSession.js";
import { useFollowOutput } from "../hooks/useFollowOutput.js";
import { useResponsiveSidebar } from "../hooks/useResponsiveSidebar.js";
import {
  useAppendEntrance,
  useEntrance,
  useSwitchEntrance,
} from "../lib/gsap-motion.js";
import { closeDetailsOnEscape } from "../lib/details-popover.js";
import { stepDisplayBody } from "./Workspace/step-display.js";
import { useSessionList } from "../hooks/useSessionList.js";
import type { MessageKey } from "../i18n/keys.js";
import { makeT, useT } from "../i18n/LocaleProvider.js";
import type { SessionSnapshot } from "../ipc/bridge-types.js";
import {
  CONSEQUENCE_KEY,
  isDangerRisk,
  REASON_KEY,
  RISK_KEY,
} from "./Approval/risk-label.js";
import { EvidenceDetail } from "./EvidenceDetail.js";
import { AttachmentTray, type TrayItem } from "./AttachmentTray.js";
import {
  latestPictureResults,
  pictureRowOf,
  type PictureResult,
} from "../lib/picture-model-use.js";
import { useSlashMenu } from "./SlashMenu.js";
import {
  exportCommand,
  feedbackCommand,
  goalCommand,
  planCommand,
  compactCommand,
  useBackendCommands,
} from "./ComposerActions.js";
import {
  EFFORT_WORDS,
  type FeedbackContext,
  FeedbackPanel,
  type FeedbackRequest,
  PERMISSION_WORDS,
} from "./FeedbackPanel.js";
import { GoalPanel, GoalStrip, useGoalController } from "./GoalPanel.js";
import { PlanPanel, PlanStrip, usePlanController } from "./PlanPanel.js";
import { CompactStrip, WorkbenchCompactPanel, useWorkbenchCompact } from "./WorkbenchCompactPanel.js";
import { FullAccessConfirmation } from "./FullAccessConfirmation.js";
import { runSessionExport } from "./Sidebar/session-markdown.js";
import { attachmentImageUrl } from "../../shared/attachment-image.js";
import type { StagedImageInfo } from "../ipc/bridge-types.js";
import { MessageContent } from "./MessageContent.js";
import { MessageTime } from "./MessageTime.js";
import { ProjectSidebar } from "./ProjectSidebar.js";
import { RecoveryFacts } from "./RecoveryFacts.js";
import { DemoPanel } from "./RoundTwoWorkbench.js";
import { SettingsModal } from "./Settings/SettingsModal.js";
import { UserInputCard } from "./UserInputCard.js";
import { RoundResults } from "./RoundResults.js";
import { RoundReader } from "./RoundReader.js";
import { RoundDashboard } from "./RoundDashboard.js";
import "../styles/round-three.css";
import "../styles/round-ten.css";

type Demo = "chat" | "approval" | "diff";
function projectName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || path
  );
}
const NO_ROUNDS: RoundSummary[] = [];
function readDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Something handed to the composer: a picked or dropped file by path, or a pasted
 *  picture by its bytes (a screenshot on the clipboard has no path at all, R81). */
interface AttachInput {
  readonly path?: string;
  readonly bytes?: Uint8Array;
  readonly name: string;
}
function attachInputFromPath(path: string): AttachInput {
  return { path, name: path.split(/[\\/]/).at(-1) || path };
}
function pastedImageName(mime: string): string {
  const sub = mime.split("/")[1] ?? "png";
  return `pasted-image.${sub === "jpeg" ? "jpg" : sub.replace(/[^a-z0-9]/gi, "")}`;
}
/** The pending-document queue's storage problems, in the words this surface uses (R91). */
const PENDING_DOCS_ISSUES: Record<PendingDocsIssue, string> = {
  unreadable: "待发附件记录无法读取，原记录未清除。请勿关闭窗口，并检查本机存储。",
  not_overwritten: "待发附件记录无法更新，原记录未覆盖；当前附件仅在本窗口保留。",
  not_saved: "待发附件保存失败，当前改动仅在本窗口保留；重新打开前请核对附件。",
};
/** The issue record's storage problems (R99). */
const ATTACH_ISSUES_PROBLEMS: Record<AttachIssuesProblem, string> = {
  unreadable: "未添加成功的附件记录无法读取，原记录未清除。请检查本机存储。",
  not_overwritten: "未添加成功的附件记录无法更新，原记录未覆盖；当前卡片仅在本窗口保留。",
  not_saved: "未添加成功的附件记录保存失败，当前卡片仅在本窗口保留。",
};
/** A card for a file that is not (yet) an attachment. `retry: false`: nothing to retry with. */
interface FailedCard {
  readonly id: string;
  readonly input: AttachInput;
  readonly error: string;
  readonly retry?: false;
}
/** A stored issue as the card it was (R99): a refusal keeps its reason, a read that never
 *  finished asks for a retry, and a paste whose bytes are gone asks for a fresh paste. */
function restoredCard(issue: AttachIssue): FailedCard {
  if (issue.path === undefined)
    return {
      id: issue.id,
      input: { name: issue.name },
      error: issue.error ? `${issue.error}粘贴的图片没有保留，需要时请重新粘贴。` : "粘贴的图片没有保留，请重新粘贴。",
      retry: false,
    };
  return {
    id: issue.id,
    input: { path: issue.path, name: issue.name },
    error: issue.error ?? "上次关闭或切换任务时还没添加完成，请重试或移除。",
  };
}
/** Main's staging refusals are internal words; the card says what they mean. */
function stagingRefusal(reason: string | undefined): string {
  if (reason === "a turn is in progress") return "黑塔正在处理本轮，结束后再添加。";
  if (reason === "five images per message") return "一条消息最多附带 5 张图片。";
  if (reason === "denied") return "涉及密钥或凭据，已拒收。";
  if (reason === "too_large") return "图片过大，未添加。";
  if (reason === "manifest_unreadable") return "待发图片清单损坏，暂不能添加图片。请先在上方重置清单。";
  if (reason === "not_saved") return "图片未能保存到本机，未添加。请检查磁盘空间或项目目录权限后重试。";
  if (reason === "workspace changing") return "任务目录正在切换，这个文件没有添加。请稍后重新添加。";
  return "文件未能读取，请检查文件是否可读。";
}
function attachRefusal(message: string | undefined): string {
  if (message === "a turn is in progress") return "黑塔正在处理本轮，结束后再发送。";
  if (message === "too many files at once") return "一次添加的文件过多，请分开发送。";
  if (message === "workspace changing") return "任务目录正在切换，这条消息没有发送。请稍后重新发送。";
  return "文件未添加，请检查文件是否可读。";
}
/** A queued document that is gone at send (R100): the card that replaces it. */
const MISSING_AT_SEND = "发送前发现文件已被移动、删除或无法访问，这条消息没有发送。请放回原处后重试，或移除它。";
function fileKind(name: string): string {
  const ext = name.toLowerCase().split(".").at(-1) ?? "";
  if (ext === "pdf") return "PDF";
  if (ext === "docx") return "Word";
  return ext && ext !== name.toLowerCase() ? ext.toUpperCase() : "文件";
}
type AttachmentDigest = Extract<
  NonNullable<Extract<SessionSnapshot["record"][number], { kind: "system" }>["digest"]>,
  { kind: "attachment" }
>;
function attachmentDigest(
  block: SessionSnapshot["record"][number] | undefined,
): AttachmentDigest | null {
  return block?.kind === "system" && block.digest?.kind === "attachment" ? block.digest : null;
}
/**
 * Attachment rows right next to a user message are that message's files: added just
 * before it was sent, or (pictures) committed just after it. They show in its bubble,
 * above its text, instead of as separate rows (R79). Only pictures are taken from
 * after a message (R99): a turn cut short leaves its pictures directly against the
 * next message's documents, and those belong to the next message.
 */
function messageAttachments(record: SessionSnapshot["record"]): {
  readonly owner: ReadonlyMap<number, number>;
  readonly rows: ReadonlyMap<number, readonly number[]>;
} {
  const owner = new Map<number, number>();
  const rows = new Map<number, number[]>();
  record.forEach((block, index) => {
    if (block.kind !== "user") return;
    const mine: number[] = [];
    for (let i = index - 1; i >= 0 && attachmentDigest(record[i]) && !owner.has(i); i--) mine.unshift(i);
    for (let i = index + 1; i < record.length && attachmentDigest(record[i])?.image !== undefined; i++) mine.push(i);
    for (const i of mine) owner.set(i, index);
    if (mine.length) rows.set(index, mine);
  });
  return { owner, rows };
}
function attachmentItem(
  block: SessionSnapshot["record"][number],
  index: number,
): TrayItem | null {
  const d = attachmentDigest(block);
  if (!d || block.kind !== "system") return null;
  const key = `row:${index}`;
  if (d.image !== undefined && d.path && d.unreadable !== "removed" && d.unreadable !== "denied")
    return { key, name: d.name, picture: { src: attachmentImageUrl(d.path) } };
  const meta =
    d.unreadable === "removed"
      ? "已移除"
      : d.unreadable !== undefined
        ? "未取正文"
        : d.format === "pdf"
          ? `PDF${d.pages ? ` · ${d.pages} 页` : ""}`
          : d.format === "docx"
            ? "Word"
            : `${d.lines.toLocaleString()} 行`;
  return {
    key,
    name: d.name,
    meta,
    ...(block.evidenceDetail ? { preview: <EvidenceDetail text={block.evidenceDetail} /> } : {}),
  };
}

/** F04 (R116): the models a picture goes to, and why one did not, in the tray's words. */
const PICTURE_MODELS = { persona: "黑塔", executor: "执行模型" } as const;
const PICTURE_MISSED = {
  over_limit: "超出上限",
  unsupported: "未通过识图检测",
  unreadable: "副本无法读取",
  stopped: "当时已停用",
} as const;
/** F04 (R116): what the latest request did with one picture, in a few words (design 2.4). */
function pictureStatus({ sent, missed }: PictureResult): string {
  const to = `已发给${sent.map((role) => PICTURE_MODELS[role]).join("和")}`;
  const first = missed[0];
  if (!first) return to;
  if (!sent.length && missed.every((m) => m.why === first.why))
    return first.why === "unsupported"
      ? `未发：${missed.length > 1 ? "模型" : PICTURE_MODELS[first.role]}未通过识图检测`
      : `未发：${PICTURE_MISSED[first.why]}`;
  return [
    ...(sent.length ? [to] : []),
    ...missed.map(
      (m) => `${PICTURE_MODELS[m.role]}未收到（${PICTURE_MISSED[m.why]}）`,
    ),
  ].join("；");
}
/** F04 (R116): why a picture's sending did not change, under its message's tray. */
const PICTURE_USE_FAILED = {
  turn_in_progress: "黑塔正在处理本轮，结束后再更改。",
  not_found: "这条消息的图片已经变化，请重试。",
  other: "未能更改图片的发送设置，请重试。",
} as const;

/** All task facts come from the subscribed session store. Demo state stays separate. */
export function RoundThreeWorkbench(): JSX.Element {
  const { bridge, sessionStore, sessionListStore } = useHertaBridge();
  const t = useT();
  const session = useActiveSession();
  const recordT = useMemo(() => makeT(session.lang ?? "zh"), [session.lang]);
  const sessions = useSessionList();
  const initialDemo = new URLSearchParams(window.location.search).get("demo");
  const [demo, setDemo] = useState<Demo | null>(
    initialDemo === "chat" ||
      initialDemo === "approval" ||
      initialDemo === "diff"
      ? initialDemo
      : null,
  );
  const [settings, setSettings] = useState(false);
  const [settingsPage, setSettingsPage] = useState<"connections" | undefined>();
  const openSettings = useCallback((connections = false) => {
    setSettingsPage(connections ? "connections" : undefined);
    setSettings(true);
  }, []);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatVisited, setChatVisited] = useState(false);
  const selectMode = (chat: boolean) => {
    setChatOpen(chat);
    if (chat) setChatVisited(true);
  };
  const [appVersion, setAppVersion] = useState("");
  // Round results belong to the task they were read for: a switch never shows
  // the previous task's results, not even for the frame before the reset
  // effect below runs (R71).
  const [roundState, setRoundState] = useState<{
    sessionId: string | null;
    rounds: RoundSummary[];
  }>({ sessionId: null, rounds: NO_ROUNDS });
  const rounds =
    roundState.sessionId === session.sessionId ? roundState.rounds : NO_ROUNDS;
  const [metrics, setMetrics] = useState<RoundMetrics | null>(null);
  const [roundsError, setRoundsError] = useState(false);
  const [pluginFilesOwner, setPluginFilesOwner] = useState<string | null>(null);
  useEffect(() => { setPluginFilesOwner(null); }, [session.sessionId, chatOpen, settings]);
  const [readerOpen, setReaderOpen] = useState(false);
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerContent, setReaderContent] = useState<RoundFileContent | null>(
    null,
  );
  const [readerWidth, setReaderWidth] = useState(46);
  const readerSequence = useRef(0);
  const readerTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let disposed = false;
    let reading = false;
    const id = session.sessionId;
    setMetrics(null);
    setRoundsError(false);
    setReaderOpen(false);
    setReaderContent(null);
    readerSequence.current += 1;
    const refresh = async () => {
      if (reading || !id || !bridge.getRoundSummaries) return;
      reading = true;
      try {
        const [next, usage] = await Promise.all([
          bridge.getRoundSummaries(id),
          bridge.getTaskMetrics?.(id),
        ]);
        if (!disposed) {
          setRoundState({ sessionId: id, rounds: next });
          setMetrics(usage ?? null);
          setRoundsError(false);
        }
      } catch {
        if (!disposed) setRoundsError(true);
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1200);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [bridge, session.sessionId]);
  const loadRoundFile = useCallback(
    async (roundId: string, fileId: string) => {
      if (!session.sessionId || !bridge.readRoundFile) return null;
      return bridge.readRoundFile(session.sessionId, roundId, fileId);
    },
    [bridge, session.sessionId],
  );
  const closeReader = useCallback(() => {
    readerSequence.current += 1;
    setReaderOpen(false);
    readerTrigger.current?.focus({ preventScroll: true });
  }, []);
  const openRoundFile = useCallback(
    async (roundId: string, fileId: string, line?: number) => {
      const sequence = ++readerSequence.current;
      if (!readerOpen)
        readerTrigger.current = document.activeElement as HTMLElement | null;
      setReaderOpen(true);
      setReaderContent(null);
      setReaderLoading(true);
      try {
        const file = await loadRoundFile(roundId, fileId);
        if (sequence === readerSequence.current)
          setReaderContent(file ? { ...file, targetLine: line } : null);
      } catch {
        if (sequence === readerSequence.current) setReaderContent(null);
      } finally {
        if (sequence === readerSequence.current) setReaderLoading(false);
      }
    },
    [loadRoundFile, readerOpen],
  );
  useEffect(() => {
    if (!readerOpen || chatOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.isComposing &&
        event.keyCode !== 229
      ) {
        event.preventDefault();
        closeReader();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readerOpen, closeReader, chatOpen]);
  const [pendingInput, setPendingInput] = useState<PendingUserInput | null>(
    null,
  );
  useEffect(() => {
    let disposed = false;
    void bridge
      .getAppVersion?.()
      .then((version) => {
        if (!disposed) setAppVersion(version);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [bridge]);
  useEffect(() => {
    let disposed = false;
    let reading = false;
    setPendingInput(null);
    const refresh = async () => {
      if (reading || !session.sessionId || !bridge.getPendingUserInput) return;
      reading = true;
      try {
        const next = await bridge.getPendingUserInput(session.sessionId);
        if (!disposed)
          setPendingInput(next?.state === "waiting_for_input" ? next : null);
      } catch {
        /* A transient local read must not discard an unanswered question. */
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [bridge, session.sessionId]);
  const [readiness, setReadiness] = useState<ProviderReadiness | null>(null);
  const [failure, setFailure] = useState<WorkbenchFailure | null>(null);
  const [navigation, setNavigation] = useState<ProjectNavigationView | null>(
    null,
  );
  const [permission, setPermission] = useState<WorkbenchPermission | null>(
    null,
  );
  const [fullAccessChoice, setFullAccessChoice] = useState(false);
  const [permissionScope, setPermissionScope] = useState<"session" | "project">(
    "session",
  );
  const [reviewOpen, setReviewOpen] = useState(false);
  const [collapsed, setCollapsed] = useResponsiveSidebar();
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    Math.max(
      200,
      Math.min(300, Number(readDraft("the-herta.sidebar.v1")) || 240),
    ),
  );
  const [workspace, setWorkspace] = useState("");
  const [pathCopy, setPathCopy] = useState<"" | "done" | "failed">("");
  useEffect(() => {
    if (!pathCopy) return;
    const timer = setTimeout(() => setPathCopy(""), 2000);
    return () => clearTimeout(timer);
  }, [pathCopy]);
  const [draft, updateDraft] = useState(() => readDraft("the-herta.draft.v1"));
  const draftVersion = useRef({ text: draft, revision: 0 });
  // Count every edit immediately, including an edit reverted before an async action returns.
  const setDraft = useCallback((value: SetStateAction<string>) => {
    const text = typeof value === "function" ? value(draftVersion.current.text) : value;
    if (text === draftVersion.current.text) return;
    draftVersion.current = { text, revision: draftVersion.current.revision + 1 };
    updateDraft(text);
  }, []);
  const [error, setError] = useState("");
  const [notice, setNoticeText] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setNotice = useCallback((text: string) => {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    setNoticeText(text);
  }, []);
  const transientNotice = useCallback((text: string) => {
    setNotice(text);
    noticeTimer.current = setTimeout(() => { noticeTimer.current = null; setNoticeText(""); }, 3500);
  }, [setNotice]);
  useEffect(() => () => { if (noticeTimer.current !== null) clearTimeout(noticeTimer.current); }, []);
  const [operation, setOperation] = useState(false);
  const [navigationTarget, setNavigationTarget] = useState<
    string | null | undefined
  >();
  const [submitting, setSubmitting] = useState(false);
  const [rename, setRename] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [filePath, setFilePath] = useState("");
  const [fileResult, setFileResult] = useState<{
    sessionId: string;
    path: string;
    text: string;
  } | null>(null);
  const [resolving, setResolving] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const tail = useFollowOutput(content, 48);
  // Chat ⇄ workbench swaps fade the surface in, and a message the user just
  // sent rises in; streamed replies already arrive progressively, and loading
  // earlier history changes the scope, so neither animates (R46).
  const main = useRef<HTMLElement>(null);
  useEntrance(main, "panel", chatOpen, !chatOpen);
  useAppendEntrance(
    content,
    session.record.map((_, index) => String(session.recordStart + index)),
    `${session.sessionId}:${session.recordStart}`,
    "message",
    !chatOpen,
  );
  // 回到最新 rises like the other small popovers when the reader scrolls away (R54).
  const latest = useRef<HTMLButtonElement>(null);
  useEntrance(latest, "popover-up", Boolean(tail.away && !demo && session.sessionId), !chatOpen);
  const opLock = useRef(false);
  const submitLock = useRef(false);
  const sentDraft = useRef<{
    id: string;
    text: string;
    start: number;
    sourceKey: string;
    accepted: boolean;
  } | null>(null);
  useEffect(() => {
    const sent = sentDraft.current;
    if (!sent || sent.accepted || sent.id !== session.sessionId) return;
    const accepted = session.record.some(
      (block, index) =>
        session.recordStart + index >= sent.start &&
        block.kind === "user" &&
        block.text === sent.text,
    );
    if (!accepted) return;
    sent.accepted = true;
    setDraft((current) => (current === sent.text ? "" : current));
    for (const key of [sent.sourceKey, `the-herta.draft.session.${sent.id}`]) {
      try {
        if (localStorage.getItem(key) === sent.text)
          localStorage.setItem(key, "");
      } catch {
        /* Preserve visible editing on storage failure. */
      }
    }
  }, [session.record, session.recordStart, session.sessionId]);
  const approvalLock = useRef<string | null>(null);
  const fileSequence = useRef(0);
  const activeId = useRef(session.sessionId);
  const sessionRevision = useRef(0);
  if (activeId.current !== session.sessionId) sessionRevision.current += 1;
  activeId.current = session.sessionId;
  // What the next message carries, as cards in the composer until it is sent (R79).
  // Pictures are staged main-side and come back with the task's snapshot; other
  // files wait here as paths and are added to the task with the message, right
  // before it, so they read as that message's files rather than the task's.
  const [pendingImages, setPendingImages] = useState<StagedImageInfo[]>([]);
  const [pendingDocs, setPendingDocs] = useState<PendingDoc[]>([]);
  const [attachReading, setAttachReading] = useState<{ id: string; name: string }[]>([]);
  const [attachFailed, setAttachFailed] = useState<FailedCard[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const docsBySession = useRef(new Map<string, PendingDoc[]>());
  const docStorageErrors = useRef(new Map<string, string>());
  const issuesBySession = useRef(new Map<string, AttachIssue[]>());
  const [docStorageError, setDocStorageError] = useState("");
  // Composer-local attachment problems sit with the cards they concern, not in
  // the task's error card beside its connection button (R98).
  const [attachError, setAttachError] = useState("");
  const [resetAsk, setResetAsk] = useState(false);
  const [resetting, setResetting] = useState(false);
  const resetOffer = useRef<HTMLButtonElement>(null);
  const resetConfirm = useRef<HTMLButtonElement>(null);
  const resetAsked = useRef(false);
  // The pressed button is replaced by its confirmation (and back): keep focus on the swap.
  useEffect(() => {
    if (resetAsk) resetConfirm.current?.focus({ preventScroll: true });
    else if (resetAsked.current) resetOffer.current?.focus({ preventScroll: true });
    resetAsked.current = resetAsk;
  }, [resetAsk]);
  const cancelledAttach = useRef(new Set<string>());
  const attachSerial = useRef(0);
  useEffect(() => {
    // A task's documents wait with it, like a chat's (R70).
    setPendingImages([]);
    const id = session.sessionId;
    if (id && !docsBySession.current.has(id)) {
      const saved = readPendingDocs(id);
      docsBySession.current.set(id, saved.docs);
      if (saved.error) docStorageErrors.current.set(id, PENDING_DOCS_ISSUES[saved.error]);
    }
    setPendingDocs((id && docsBySession.current.get(id)) || []);
    setDocStorageError((id && docStorageErrors.current.get(id)) || "");
    setAttachReading([]);
    setAttachError("");
    setResetAsk(false);
    // A card that never became an attachment comes back with its task (R99): a read
    // the switch or the close cut short is now a card to retry, not a silent gap.
    if (id && !issuesBySession.current.has(id)) {
      const saved = readAttachIssues(id);
      issuesBySession.current.set(id, saved.issues);
      if (saved.error) setAttachError(ATTACH_ISSUES_PROBLEMS[saved.error]);
    }
    setAttachFailed(((id && issuesBySession.current.get(id)) || []).map(restoredCard));
  }, [session.sessionId]);
  useEffect(() => {
    if (!session.restagedImages) return;
    const restored = session.restagedImages;
    setPendingImages([...restored]);
    // A display name cannot identify an import: different directories and
    // clipboard captures can share it. Keep unresolved cards until the user
    // retries or removes them; a possible duplicate is safer than silent loss.
    sessionStore.clearRestagedImages();
  }, [session.restagedImages, sessionStore]);
  /** Cards that never became attachments, kept per task across a restart (R99). */
  const keepIssues = (id: string, change: (list: AttachIssue[]) => AttachIssue[]) => {
    const next = change(issuesBySession.current.get(id) ?? []);
    issuesBySession.current.set(id, next);
    const problem = writeAttachIssues(id, next);
    if (problem && activeId.current === id) setAttachError(ATTACH_ISSUES_PROBLEMS[problem]);
  };
  const keepDocs = (id: string, next: PendingDoc[]) => {
    docsBySession.current.set(id, next);
    const issue = writePendingDocs(id, next);
    const failure = issue && PENDING_DOCS_ISSUES[issue];
    if (failure) docStorageErrors.current.set(id, failure);
    else docStorageErrors.current.delete(id);
    if (activeId.current === id) setDocStorageError(failure ?? "");
    if (activeId.current === id) setPendingDocs(next);
  };
  /** Stage each picked file on its own: a picture is stored for this message, another
   *  file waits as a path, and a refused one keeps a card that says why. */
  const addAttachments = async (id: string, inputs: readonly AttachInput[]) => {
    const revision = sessionRevision.current;
    const current = () => activeId.current === id && sessionRevision.current === revision;
    setNotice("");
    setError("");
    setAttachError("");
    const picked = inputs.map((input) => ({
      key: `w${++attachSerial.current}-${crypto.randomUUID()}`,
      input,
      name: input.name,
    }));
    setAttachReading((r) => [...r, ...picked.map((p) => ({ id: p.key, name: p.name }))]);
    // On record until it becomes an attachment (R99); a paste keeps its name, never its bytes.
    keepIssues(id, (list) => [
      ...list,
      ...picked.map((p): AttachIssue => ({ id: p.key, name: p.name, ...(p.input.path !== undefined ? { path: p.input.path } : {}) })),
    ]);
    for (const p of picked) {
      if (!current()) return;
      if (cancelledAttach.current.has(p.key)) continue;
      let staged: StagedImageInfo | null = null;
      let document = false;
      let refusal = "文件未能读取，请检查文件是否可读。";
      try {
        // The card's key is the job a cancel names (R118).
        const reply = await bridge.stageImages(id, [p.input], p.key);
        if (!reply.ok) refusal = stagingRefusal(reply.message);
        else if (reply.staged[0]) staged = reply.staged[0];
        else if (reply.rejected[0]?.reason === "not_image") {
          // Only a file on disk can wait as a document; pasted bytes must be a picture.
          if (p.input.path !== undefined) document = true;
          else refusal = "只能粘贴 PNG、JPEG 等图片。";
        } else refusal = stagingRefusal(reply.rejected[0]?.reason);
      } catch {
        /* the default refusal says so */
      }
      // Cancelled while it was staged, or the task changed: the copy is dropped. Since R118 a
      // cancel that reached the main process in time leaves no copy; this catches one that did not.
      if (!current() || cancelledAttach.current.has(p.key)) {
        if (staged) void bridge.unstageImage(id, staged.id);
        if (!current()) return;
        continue;
      }
      setAttachReading((r) => r.filter((x) => x.id !== p.key));
      if (staged) setPendingImages((list) => [...list, staged]);
      else if (document && p.input.path !== undefined) {
        // Read the current queue after the await: a user may have removed a
        // previous document while this file was being staged.
        keepDocs(id, [...(docsBySession.current.get(id) ?? []), { id: p.key, path: p.input.path, name: p.name }]);
      } else setAttachFailed((list) => [...list, { id: p.key, input: p.input, error: refusal }]);
      if (staged || document) keepIssues(id, (list) => list.filter((i) => i.id !== p.key));
      else keepIssues(id, (list) => list.map((i) => (i.id === p.key ? { ...i, error: refusal } : i)));
    }
  };
  const canAttach = (): boolean =>
    Boolean(session.sessionId) && !busy && !operation && !pendingInput && attachReading.length === 0;
  // A screenshot is Ctrl+V and a file from Explorer is a drop (R81): both become the
  // same cards as "添加文件", so the same per-file staging and refusals apply.
  const onComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    slash.onPaste();
    const files = Array.from(event.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return; // ordinary text paste: leave it alone
    event.preventDefault();
    const id = session.sessionId;
    if (!id || !canAttach()) {
      setNotice(busy ? "黑塔正在处理本轮，结束后再添加图片。" : "当前无法添加图片。");
      return;
    }
    const pasteRevision = sessionRevision.current;
    void Promise.all(
      files.map(async (f): Promise<AttachInput> => ({
        bytes: new Uint8Array(await f.arrayBuffer()),
        name: f.name && f.name !== "image.png" ? f.name : pastedImageName(f.type),
      })),
    ).then(
      (items) => {
        if (activeId.current === id && sessionRevision.current === pasteRevision) void addAttachments(id, items);
      },
      () => {
        if (activeId.current === id && sessionRevision.current === pasteRevision) setAttachError("剪贴板图片未能读取。");
      },
    );
  };
  const dropHandlers = {
    onDragEnter: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      dragDepth.current += 1;
      setDragOver(true);
    },
    onDragOver: (event: DragEvent) => {
      // Without preventDefault the window navigates to the file and drop never fires.
      if (event.dataTransfer.types.includes("Files")) event.preventDefault();
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragOver(false);
    },
    onDrop: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      const id = session.sessionId;
      if (!id || !canAttach()) {
        setNotice(busy ? "黑塔正在处理本轮，结束后再添加文件。" : "当前无法添加文件。");
        return;
      }
      const paths = Array.from(event.dataTransfer.files)
        .map((f) => bridge.pathForFile(f))
        .filter((p) => p.length > 0);
      if (!paths.length) return;
      void addAttachments(id, paths.map(attachInputFromPath));
      input.current?.focus({ preventScroll: true });
    },
  };
  const removePendingAttachment = (key: string) => {
    const id = session.sessionId;
    if (!id) return;
    const ref = key.slice(2);
    if (key.startsWith("i:")) {
      const removed = pendingImages.find((image) => image.id === ref);
      const revision = sessionRevision.current;
      setPendingImages((list) => list.filter((image) => image.id !== ref));
      void bridge.unstageImage(id, ref).then((ok) => {
        if (!ok) throw new Error("not removed");
        if (activeId.current !== id || sessionRevision.current !== revision) return;
        // A removal that worked takes an earlier refusal with it, and so does a
        // send that was refused over a picture (R98).
        setAttachError("");
        setFailure((current) => (current?.action === "attachment" ? null : current));
      }).catch(() => {
        if (activeId.current !== id || sessionRevision.current !== revision) return;
        if (removed) setPendingImages((list) => list.some((image) => image.id === ref) ? list : [...list, removed]);
        setAttachError("图片未能移除，卡片已保留。请检查存储后重试。");
      });
    } else if (key.startsWith("d:")) keepDocs(id, pendingDocs.filter((d) => d.id !== ref));
    else {
      setAttachFailed((list) => list.filter((f) => f.id !== ref));
      keepIssues(id, (list) => list.filter((i) => i.id !== ref));
    }
  };
  /** The confirmed reset of an unreadable pending-picture manifest (R98): main
   *  renames the damaged file and keeps it; no picture file is deleted. */
  const resetPendingManifest = async (): Promise<void> => {
    const id = session.sessionId;
    if (!id || !bridge.resetPendingImages || resetting) return;
    const revision = sessionRevision.current;
    const current = () => activeId.current === id && sessionRevision.current === revision;
    setResetting(true);
    setAttachError("");
    try {
      const result = await bridge.resetPendingImages(id);
      if (!current()) return;
      if (result.ok || result.reason === "nothing_to_reset") {
        sessionStore.clearStagedImageError(id);
        setResetAsk(false);
        if (result.ok)
          setNotice(`待发图片清单已重置；损坏的原清单另存为 ${result.backup}，图片文件未删除。需要的图片请重新添加。`);
      } else
        setAttachError(
          result.reason === "turn_in_progress"
            ? "黑塔正在处理本轮，结束后再重置清单。"
            : "清单未能重置，原文件保留。请检查存储权限后重试。",
        );
    } catch {
      if (current()) setAttachError("清单未能重置，原文件保留。请检查存储权限后重试。");
    } finally {
      setResetting(false);
    }
  };
  const [promptRequest, setPromptRequest] = useState<{ pluginId: string; actionId: string; title: string; nonce: number } | null>(null);
  // `/feedback` (R125): each run opens the panel with what the workbench shows then.
  const [feedbackRequest, setFeedbackRequest] =
    useState<FeedbackRequest | null>(null);
  const attached = useMemo(() => messageAttachments(session.record), [session.record]);
  // F04 (R116): what the newest request did with each picture row, by absolute index and path.
  const recordEnd = session.recordStart + session.record.length;
  const pictureResults = useMemo(
    () => latestPictureResults(rounds, recordEnd),
    [rounds, recordEnd],
  );
  const attachmentsOf = (userIndex: number): TrayItem[] => {
    const items = (attached.rows.get(userIndex) ?? []).flatMap((i) => {
      const block = session.record[i];
      const item = block ? attachmentItem(block, i) : null;
      const row = item?.picture ? pictureRowOf(attachmentDigest(block)) : null;
      if (!item?.picture || !row) return item ? [item] : [];
      // A stopped picture says so before anything the last request did (design 2.4).
      const result = row.stopped
        ? undefined
        : pictureResults(session.recordStart + i, row.path);
      const status = row.stopped
        ? "不再发给模型"
        : result && pictureStatus(result);
      return [
        {
          ...item,
          picture: {
            ...item.picture,
            modelUse: { stopped: row.stopped, ...(status ? { status } : {}) },
          },
        },
      ];
    });
    return [...items.filter((i) => i.picture), ...items.filter((i) => !i.picture)];
  };
  // F04 (R116): one change in flight at a time, and why the last one did not happen, by the
  // message's absolute record index; both belong to the task they were asked in.
  const [pictureUse, setPictureUse] = useState<{
    readonly sessionId: string;
    readonly message: number;
    readonly pending: boolean;
    readonly note?: string;
  } | null>(null);
  const pictureUseHere =
    pictureUse?.sessionId === session.sessionId ? pictureUse : null;
  const changePictureUse = (
    userIndex: number,
    keys: readonly string[],
    use: "stop" | "send",
  ) => {
    const id = session.sessionId;
    if (!id || !bridge.setPictureModelUse || pictureUseHere?.pending) return;
    const targets = keys.flatMap((key) => {
      const i = Number(key.slice("row:".length));
      const row = pictureRowOf(attachmentDigest(session.record[i]));
      return row ? [{ index: session.recordStart + i, path: row.path }] : [];
    });
    if (!targets.length) return;
    const message = session.recordStart + userIndex;
    const revision = sessionRevision.current;
    // The answer always ends its own wait; its note shows only if the window is still on that task.
    const settle = (note?: string) => {
      const here =
        activeId.current === id && sessionRevision.current === revision;
      setPictureUse((current) =>
        current?.sessionId !== id || current.message !== message
          ? current
          : here && note
            ? { sessionId: id, message, pending: false, note }
            : null,
      );
    };
    setPictureUse({ sessionId: id, message, pending: true });
    bridge.setPictureModelUse(id, targets, use).then(
      (reply) =>
        settle(
          reply.ok
            ? undefined
            : reply.reason === "turn_in_progress" ||
                reply.reason === "not_found"
              ? PICTURE_USE_FAILED[reply.reason]
              : PICTURE_USE_FAILED.other,
        ),
      () => settle(PICTURE_USE_FAILED.other),
    );
  };
  const pendingItems: TrayItem[] = [
    ...pendingImages.map((image): TrayItem => ({
      key: `i:${image.id}`,
      name: image.name,
      picture: { src: attachmentImageUrl(image.path) },
    })),
    ...pendingDocs.map((d): TrayItem => ({ key: `d:${d.id}`, name: d.name, meta: fileKind(d.name) })),
    ...attachReading.map((r): TrayItem => ({ key: `r:${r.id}`, name: r.name, state: "reading" })),
    ...attachFailed.map((f): TrayItem => ({ key: `f:${f.id}`, name: f.input.name, state: "failed", error: f.error, ...(f.retry === false ? { retry: false as const } : {}) })),
  ];
  const refreshWorkbench = useCallback(async () => {
    const id = session.sessionId;
    try {
      const [nextReadiness, nextNavigation, nextPermission] = await Promise.all(
        [
          bridge.getProviderReadiness?.(id ?? undefined),
          bridge.getProjectNavigation?.(),
          bridge.getWorkbenchPermission?.(),
        ],
      );
      if (activeId.current !== id) return;
      if (nextReadiness) setReadiness(nextReadiness);
      if (nextNavigation) setNavigation(nextNavigation);
      if (nextPermission) setPermission(nextPermission);
    } catch {
      if (activeId.current === id)
        setError("本地配置或项目导航无法读取。原数据保留，请检查设置。");
    }
  }, [bridge, session.sessionId]);
  // Re-read authoritative local facts after settings close and session-list updates; no API call.
  // biome-ignore lint/correctness/useExhaustiveDependencies: session-list updates can change navigation without changing the active ID.
  useEffect(() => {
    if (!settings) void refreshWorkbench();
  }, [refreshWorkbench, settings, sessions]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing the active session clears local failure and confirmation state.
  useEffect(() => {
    setFailure(null);
    setFullAccessChoice(false);
  }, [session.sessionId]);
  const updateNavigation = useCallback(
    async (value: NavigationMutation): Promise<void> => {
      if (!bridge.updateProjectNavigation) return;
      setNavigation(await bridge.updateProjectNavigation(value));
      await sessionListStore.refresh();
      await refreshWorkbench();
    },
    [bridge, sessionListStore, refreshWorkbench],
  );
  const choosePermission = async (
    mode: PermissionMode,
    confirmed = false,
  ): Promise<void> => {
    if (!permission?.sessionId || !bridge.setWorkbenchPermission || plan.locked || permission.planLocked) return;
    if (mode === "full-access" && !confirmed) {
      setFullAccessChoice(true);
      return;
    }
    try {
      setPermission(
        await bridge.setWorkbenchPermission({
          sessionId: permission.sessionId,
          mode,
          scope: permissionScope,
          expectedRevision: permission.revision,
          ...(confirmed ? { confirmFullAccess: true } : {}),
        }),
      );
      setFullAccessChoice(false);
      transientNotice("权限已更新。");
    } catch {
      setError("权限选择未保存，可能因任务切换或设置已更新。请重新选择。");
      await refreshWorkbench();
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new session resets the user's scroll-follow choice.
  useLayoutEffect(() => {
    tail.jump();
  }, [session.sessionId]);
  // Landed on the newest line before paint, a switched-to task's record comes
  // in one by one; its round results, read a moment later, join in (R71).
  useSwitchEntrance(content, session.sessionId, ".herta-transcript > *", 600, !chatOpen);
  // biome-ignore lint/correctness/useExhaustiveDependencies: append/stream/round-result changes trigger DOM measurement without replacing the user's selection or focus.
  useEffect(() => {
    tail.stick();
  }, [session.record.length, session.streamingText, session.sessionId, rounds]);
  const busy = submitting || session.status !== "idle" || session.backendActive;
  /** F04 (R116): a sent message's picture switches, for its tray (by the message's window index). */
  const pictureUseFor = (userIndex: number) =>
    bridge.setPictureModelUse
      ? {
          onModelUse: (keys: readonly string[], use: "stop" | "send") =>
            changePictureUse(userIndex, keys, use),
          // One change at a time: a click while one is pending asks for nothing (changePictureUse).
          // The switches stay enabled meanwhile, or the focused one would lose its focus.
          disabled: busy,
          note:
            pictureUseHere?.message === session.recordStart + userIndex
              ? pictureUseHere.note
              : undefined,
        }
      : {};
  const visibleFailure =
    failure ??
    (session.turnFailed
      ? safeProviderFailure({
          code: session.turnFailedProviderCode,
          status: session.turnFailedStatus,
        })
      : null);
  // The error card's words, null when there is no card; `/feedback` may quote them (R125).
  const errorCardText =
    failure || error || session.error || session.turnFailed
      ? visibleFailure?.message ||
        error ||
        (session.error
          ? "本地任务服务无法加载，请检查配置。原数据保留。"
          : session.turnFailedStatus === 401 || session.turnFailedStatus === 403
            ? "服务拒绝鉴权或访问权限，请检查该连接的 Key 和账户授权。"
            : session.turnFailedStatus === 429
              ? "服务限流，请稍后再试。"
              : "本轮请求未完成，已保存的结果保留；不会重复执行工具。")
      : null;
  const draftKey = session.sessionId
    ? `the-herta.draft.session.${session.sessionId}`
    : "the-herta.draft.v1";
  const previousDraftKey = useRef(draftKey);
  useEffect(() => {
    if (previousDraftKey.current !== draftKey) {
      previousDraftKey.current = draftKey;
      setDraft(readDraft(draftKey));
      setError("");
      setNotice("");
      setFileResult(null);
      fileSequence.current += 1;
      return;
    }
    try {
      localStorage.setItem(draftKey, draft);
    } catch {
      setError("草稿保存失败，请复制文本后再退出。当前输入仍保留。");
    }
  }, [draft, draftKey]);
  useEffect(() => {
    try {
      localStorage.setItem("the-herta.sidebar.v1", String(sidebarWidth));
    } catch {
      setError("布局保存失败，当前布局仍可使用。");
    }
  }, [sidebarWidth]);
  useEffect(() => bridge.onOpenSettings?.(() => openSettings()), [bridge, openSettings]);
  useEffect(() => {
    if (session.backendWorkspace) setWorkspace(session.backendWorkspace);
  }, [session.backendWorkspace]);
  const openProject = useCallback(async (): Promise<void> => {
    try {
      const path = await bridge.pickWorkspace();
      if (path) {
        setWorkspace(path);
        if (bridge.updateProjectNavigation)
          await updateNavigation({ kind: "create-project", path });
        setDemo(null);
        setNotice(
          "已选定新项目，新建任务时才会使用；当前任务的目录不变。",
        );
      }
    } catch {
      setError("无法打开文件夹选择器。未更改项目。");
    }
  }, [bridge, updateNavigation]);
  const create = useCallback(
    async (
      confirmed = false,
      workspaceOverride?: string | null,
    ): Promise<SessionSnapshot | null> => {
      if (opLock.current || session.overlay) return null;
      if (busy && !confirmed) {
        setNavigationTarget(null);
        return null;
      }
      opLock.current = true;
      setOperation(true);
      setError("");
      try {
        const selectedWorkspace =
          workspaceOverride === undefined ? workspace : workspaceOverride;
        const result = await bridge.createSession(
          selectedWorkspace
            ? {
                workspaceRoot: selectedWorkspace,
                backendWorkspace: selectedWorkspace,
                lang: "zh",
              }
            : { lang: "zh" },
          confirmed && session.sessionId
            ? { interruptActiveSessionId: session.sessionId }
            : undefined,
        );
        if (!result) throw new Error("no session");
        setDemo(null);
        return result;
      } catch {
        setError(
          "无法创建任务。请检查项目目录与本地服务，现有任务及输入保留。",
        );
        return null;
      } finally {
        opLock.current = false;
        setOperation(false);
      }
    },
    [bridge, workspace, busy, session.overlay, session.sessionId],
  );
  const open = async (id: string, confirmed = false): Promise<void> => {
    if (opLock.current || session.overlay || id === session.sessionId) return;
    if (busy && !confirmed) {
      setNavigationTarget(id);
      return;
    }
    opLock.current = true;
    setOperation(true);
    setError("");
    try {
      const result = await bridge.openSession(
        id,
        confirmed && session.sessionId
          ? { interruptActiveSessionId: session.sessionId }
          : undefined,
      );
      if (!result) throw new Error("no session");
      if ("openError" in result) {
        setError(
          `这个任务的记录无法读取（${result.openError.code}${result.openError.line ? `，第 ${result.openError.line} 行` : ""}），当前任务保持不变。`,
        );
        return;
      }
      setDemo(null);
    } catch {
      setError("无法打开历史任务，当前任务保持不变。");
    } finally {
      opLock.current = false;
      setOperation(false);
    }
  };
  const submit = async (): Promise<void> => {
    if (
      submitLock.current ||
      busy ||
      pendingInput ||
      demo !== null ||
      !draft.trim()
    )
      return;
    // A file still being read, or one that could not be added, is never skipped quietly (R79).
    if (attachReading.length) {
      setError("附件还在读取，请稍候再发送。");
      return;
    }
    if (attachFailed.length) {
      setError("还有附件没有添加成功：请重试或移除它，再发送。");
      return;
    }
    const text = draft;
    const sourceKey = draftKey;
    let submittedId = session.sessionId;
    submitLock.current = true;
    try {
      let id = session.sessionId;
      if (!id) {
        const created = await create();
        if (!created) return;
        id = created.sessionId;
        submittedId = id;
        // Carry the welcome draft into the newly created task before submitting.
        // A failed configuration/network check must never erase the user's text.
        try {
          localStorage.setItem(`the-herta.draft.session.${id}`, text);
        } catch {
          setError("草稿保存失败，当前文本仍保留。");
        }
        setDraft(text);
      }
      setSubmitting(true);
      setError("");
      setFailure(null);
      const sendingRevision = sessionRevision.current;
      const checked = await bridge.getProviderReadiness?.(id);
      if (activeId.current !== id || sessionRevision.current !== sendingRevision) return;
      if (checked) {
        setReadiness(checked);
        if (!checked.ready && checked.issue) {
          setFailure({ ...checked.issue, stage: "configuration" });
          return;
        }
      }
      sentDraft.current = {
        id,
        text,
        start:
          id === session.sessionId
            ? session.recordStart + session.record.length
            : 0,
        sourceKey,
        accepted: false,
      };
      // This message's files are added to the task right before it, so they sit next to
      // it in the record; its pictures go by their staged ids (R79).
      const docs = id === session.sessionId ? pendingDocs : [];
      const images = id === session.sessionId ? pendingImages : [];
      if (docs.length && images.length && bridge.prepareStagedImages) {
        // A picture restored from an earlier session is read now (R98): when it cannot
        // be, nothing of this message is committed — its documents stay cards too.
        const prepared = await bridge.prepareStagedImages(id, images.map((image) => image.id));
        if (activeId.current !== id || sessionRevision.current !== sendingRevision) return;
        if (!prepared.ok || prepared.unreadable.length) {
          setFailure({
            code: "image-unreadable",
            stage: "configuration",
            action: "attachment",
            message: prepared.ok
              ? "图片没有发给模型：待发图片的本机副本缺失或无法读取。请移除显示“图片缺失”的卡片后重新添加；文字草稿和其他附件仍保留。"
              : "附件状态已变化，这条消息没有发送。请确认待发附件后重新发送。",
          });
          return;
        }
      }
      if (docs.length) {
        const attached = await bridge.attachFiles(
          id,
          docs.map((d) => d.path),
          { requireAll: true },
        );
        if (!attached.ok) {
          const gone = new Set(attached.missing ?? []);
          if (activeId.current === id && gone.size) {
            // A queued file no longer where it was (R100): nothing of the message
            // went, and its card says why until the file is back or removed.
            const lost = docs.filter((d) => gone.has(d.path));
            keepDocs(id, (docsBySession.current.get(id) ?? []).filter((d) => !gone.has(d.path)));
            setAttachFailed((list) => [...list, ...lost.map((d) => ({ id: d.id, input: { path: d.path, name: d.name }, error: MISSING_AT_SEND }))]);
            keepIssues(id, (list) => [...list, ...lost.map((d) => ({ id: d.id, name: d.name, path: d.path, error: MISSING_AT_SEND }))]);
            setAttachError("有附件已不在原位置，这条消息没有发送；文字草稿已保留。");
          } else if (activeId.current === id) setError(attachRefusal(attached.message));
          return;
        }
        keepDocs(id, []);
        if (activeId.current !== id || sessionRevision.current !== sendingRevision) return;
      }
      const result = images.length
        ? await bridge.submitText(
            text,
            images.map((image) => image.id),
            id,
          )
        : await bridge.submitText(text, undefined, id);
      // Sent with the message whatever came of the turn: a failed turn has already put
      // them in the record, and the next message still shows them to the model (R77).
      // Configuration refusal has not accepted the message or its staged images.
      const configurationRefused = "needsKey" in result ||
        ("failure" in result && result.failure.stage === "configuration");
      if (images.length && !configurationRefused && activeId.current === id)
        setPendingImages((list) => list.filter((image) => !images.includes(image)));
      if ("failure" in result) {
        if (activeId.current === id) {
          setFailure(result.failure);
          // Showing the text in the record cleared the draft; a failed turn gives
          // it back for an explicit retry, never over anything typed since (R65).
          if (sentDraft.current?.id === id && sentDraft.current.accepted)
            setDraft((current) => (current === "" ? text : current));
        }
        return;
      }
      if ("needsKey" in result) {
        if (activeId.current === id)
          setError(
            "还没有可用的模型。文字已保留，请先在“连接与模型”中配置并验证。",
          );
        return;
      }
      if (sentDraft.current?.accepted) return;
      // Only clear the exact submitted draft; edits made during execution survive.
      try {
        if (localStorage.getItem(sourceKey) === text)
          localStorage.setItem(sourceKey, "");
      } catch {
        /* visible draft remains until cleared below */
      }
      if (activeId.current === id)
        setDraft((current) => (current === text ? "" : current));
    } catch {
      if (activeId.current === submittedId)
        setError(
          "请求失败，文字已保留。请检查连接设置或网络；不会自动重发，也不会重复执行工具。",
        );
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };
  const cancel = async (): Promise<void> => {
    const id = session.sessionId;
    try {
      const result = await bridge.interrupt();
      if (activeId.current !== id) return;
      if (!result.ok) setError("没有可取消的活动轮次。");
      else
        setNotice(
          "已请求取消。正在运行的工具以任务记录中的结束状态为准；已写入的改动不会自动撤销。",
        );
    } catch {
      if (activeId.current === id)
        setError("取消请求失败，请检查本地服务状态。");
    }
  };
  const resume = async (): Promise<void> => {
    if (
      submitLock.current ||
      busy ||
      pendingInput ||
      !bridge.continueInterrupted
    )
      return;
    submitLock.current = true;
    setSubmitting(true);
    setError("");
    const id = session.sessionId;
    try {
      const result = await bridge.continueInterrupted();
      if (activeId.current !== id) return;
      if ("unavailable" in result) setError("当前任务没有可恢复的中断运行。");
      else if ("needsKey" in result)
        setError("请先配置并验证 Provider，再明确恢复任务。");
    } catch {
      if (activeId.current === id)
        setError("恢复失败，已保存的结果保留；已完成的操作不会重复执行。");
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };
  const saveName = async (): Promise<void> => {
    if (!rename || !bridge.renameSession || !renameTitle.trim()) return;
    try {
      const result = await bridge.renameSession(rename, renameTitle);
      if (!result.ok) throw new Error("rename");
      sessionListStore.applyUserTitle(rename, result.title);
      sessionStore.applyUserTitle(rename, result.title);
      setRename(null);
    } catch {
      setError("任务重命名失败，原名称保留。");
    }
  };
  const readFile = async (diff: boolean): Promise<void> => {
    const id = session.sessionId;
    if (!id || !filePath.trim()) return;
    const sequence = ++fileSequence.current;
    const path = filePath.trim();
    try {
      let text: string;
      if (diff) {
        const result = await bridge.readWorkspaceDiff?.(id, path);
        text = !result
          ? "此版本无法读取 diff。"
          : !result.ok
            ? `diff 读取失败：${result.reason}`
            : result.diff.added === null
              ? "二进制文件无法显示文本 diff。"
              : `${result.diff.patch || "没有变更。"}${result.diff.patchTruncated ? "\n[仅显示截断后的 diff]" : ""}`;
      } else {
        const result = await bridge.readWorkspaceFile?.(id, path);
        text = !result
          ? "此版本无法读取文件。"
          : !result.ok
            ? `文件读取失败：${result.reason}`
            : `${result.content || "[空文件]"}${result.truncated ? "\n[内容过大，仅显示前缀]" : ""}`;
      }
      if (sequence === fileSequence.current && activeId.current === id)
        setFileResult({ sessionId: id, path, text });
    } catch {
      if (activeId.current === id) setError("文件读取失败。未修改磁盘内容。");
    }
  };
  const overlay =
    session.overlay?.kind === "pending-permission" ||
    session.overlay?.kind === "pending-command"
      ? session.overlay
      : null;
  // The card leads with the decision: risk, the reason in the UI language and
  // the command. The rule's English reason, raw codes and IDs stay readable
  // under 诊断信息 (R45; same localization tables as the approval panel).
  const permissionAsk = overlay?.kind === "pending-permission" ? overlay : null;
  const askRiskKey = permissionAsk ? RISK_KEY[permissionAsk.risk] : undefined;
  const askReasonKey = permissionAsk?.code
    ? REASON_KEY[permissionAsk.code]
    : undefined;
  const askNotes: string[] = [];
  const consequenceKey = permissionAsk?.consequence
    ? CONSEQUENCE_KEY[permissionAsk.consequence]
    : undefined;
  if (consequenceKey) askNotes.push(t(consequenceKey));
  const alsoClasses = (permissionAsk?.codes ?? [])
    .filter((code) => code !== permissionAsk?.code)
    .map((code) => REASON_KEY[code])
    .filter((key): key is MessageKey => key !== undefined)
    .map((key) => t(key));
  if (alsoClasses.length)
    askNotes.push(t("approval.alsoClasses", { list: alsoClasses.join("；") }));
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new server request re-arms the approval latch.
  useEffect(() => {
    approvalLock.current = null;
    setResolving(false);
  }, [overlay?.requestId]);
  const approve = async (decision: "allow" | "deny"): Promise<void> => {
    if (!overlay || resolving || approvalLock.current === overlay.requestId)
      return;
    approvalLock.current = overlay.requestId;
    const id = session.sessionId;
    const requestId = overlay.requestId;
    setResolving(true);
    try {
      const result = await bridge.resolveApproval({
        requestId: overlay.requestId,
        decision,
        persistence: "once",
      });
      if (
        activeId.current === id &&
        approvalLock.current === requestId &&
        !result.ok
      )
        setError("审批已失效，请依据当前任务状态操作。");
    } catch {
      if (activeId.current !== id || approvalLock.current !== requestId) return;
      approvalLock.current = null;
      setResolving(false);
      setError("审批请求失败。未显示为已批准，请检查当前状态。");
    }
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.isComposing) return;
      if (event.key === ",") {
        event.preventDefault();
        openSettings();
      }
      if (chatOpen) return;
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        void openProject();
      }
      if (event.key.toLowerCase() === "l") {
        event.preventDefault();
        input.current?.focus({ preventScroll: true });
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        void create();
      }
      if (event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        setCollapsed((value) => !value);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [create, openProject, chatOpen]);
  const recent = [...new Set(sessions.map((item) => item.workspaceRoot))].slice(
    0,
    8,
  );
  const activeTask = navigation?.tasks.find(
    (task) => task.sessionId === session.sessionId && !task.recycled,
  );
  const activeProject = navigation?.projects.find(
    (project) =>
      project.projectId === activeTask?.projectId && !project.removed,
  );
  const comparablePath = (path: string): string =>
    path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const relocatedPath =
    activeProject?.path &&
    session.backendWorkspace &&
    comparablePath(activeProject.path) !==
      comparablePath(session.backendWorkspace)
      ? activeProject.path
      : null;
  const switchToProjectLocation = async (): Promise<void> => {
    const id = session.sessionId;
    if (
      !id ||
      !relocatedPath ||
      busy ||
      operation ||
      opLock.current ||
      session.overlay ||
      // A copy being written would land under the old directory (R100).
      attachReading.length > 0
    )
      return;
    opLock.current = true;
    setOperation(true);
    try {
      const result = await bridge.setWorkspace(id, relocatedPath);
      if (activeId.current !== id) return;
      if (!result.ok) throw new Error("workspace-not-changed");
      await sessionListStore.refresh();
      await refreshWorkbench();
      setNotice(
        "当前任务已使用项目新位置，后续工具在新目录执行；未移动或删除代码。",
      );
    } catch {
      if (activeId.current === id)
        setError(
          "任务目录未切换。请确认新目录存在且当前任务空闲，再主动重试。",
        );
    } finally {
      opLock.current = false;
      setOperation(false);
    }
  };
  // The / menu and the 快捷操作 menu share the composer's actions (R80), and what stops them (R123).
  const composerState = {
    noTarget: !session.sessionId,
    replying: busy,
    opening: operation,
    reading: attachReading.length > 0,
    empty:
      session.recordStart === 0 &&
      !session.record.some((block) => block.kind === "user"),
  };
  // `/export` (R124): the sidebar's export of the open task, from either menu.
  const exportId = session.sessionId;
  // `/feedback` (R125): what the workbench shows now — its error card, the failure by
  // code and the choices that shape a turn — for the user to pick from; never the task.
  const feedbackContext = (): FeedbackContext => {
    const persona = readiness?.bindings?.persona;
    const executor = readiness?.bindings?.executor;
    const model = (b: { modelId: string; reasoningEffort?: string }) =>
      b.reasoningEffort
        ? `${b.modelId} · ${EFFORT_WORDS[b.reasoningEffort] ?? b.reasoningEffort}`
        : b.modelId;
    return {
      scope: "workbench",
      error: errorCardText,
      failure: visibleFailure
        ? [
            { label: "代码", value: visibleFailure.code },
            { label: "阶段", value: visibleFailure.stage },
            ...(visibleFailure.status
              ? [{ label: "HTTP 状态", value: String(visibleFailure.status) }]
              : []),
          ]
        : null,
      settings: [
        ...(permission
          ? [
              {
                label: "权限档位",
                value: PERMISSION_WORDS[permission.mode] ?? permission.mode,
              },
            ]
          : []),
        ...(persona ? [{ label: "黑塔模型", value: model(persona) }] : []),
        ...(executor ? [{ label: "执行模型", value: model(executor) }] : []),
      ],
    };
  };
  const goal = useGoalController(
    "workbench",
    session.sessionId,
    busy || operation,
    !chatOpen && !settings && demo === null,
  );
  const plan = usePlanController(
    session.sessionId,
    busy || operation,
    !chatOpen && !settings && demo === null,
    refreshWorkbench,
    (targetId) => {
      const targetRevision = sessionRevision.current;
      const revision = draftVersion.current.revision;
      return (text) => {
        if (activeId.current !== targetId || sessionRevision.current !== targetRevision || draftVersion.current.revision !== revision) return false;
        setDraft(current => `${current.trim() ? `${current}\n\n` : ""}按以下计划处理：\n${text}`);
        transientNotice("计划已放入草稿，由你发送。");
        requestAnimationFrame(() => {
          if (activeId.current === targetId && sessionRevision.current === targetRevision) input.current?.focus({ preventScroll: true });
        });
        return true;
      };
    },
  );
  useEffect(() => {
    if (plan.locked || permission?.planLocked) setFullAccessChoice(false);
  }, [plan.locked, permission?.planLocked]);
  const compact = useWorkbenchCompact(session.sessionId, busy || operation, !chatOpen && !settings && demo === null);
  const backend = useBackendCommands(exportId ?? "welcome", [
    ...(goal.available ? [goalCommand(goal.open)] : []),
    ...(plan.available ? [planCommand(plan.toggle)] : []),
    ...(compact.available ? [compactCommand("workbench", compact.schedule)] : []),
    ...(bridge.readSessionForExport && bridge.saveSessionExport
      ? [
          exportCommand("workbench", async (signal) =>
            exportId
              ? ((await runSessionExport(
                  bridge,
                  exportId,
                  undefined,
                  signal,
                )) ?? "failed")
              : "failed",
          ),
        ]
      : []),
    ...(bridge.saveSessionExport
      ? [
          feedbackCommand(() => {
            const context = feedbackContext();
            setFeedbackRequest((r) => ({
              nonce: (r?.nonce ?? 0) + 1,
              context,
            }));
          }),
        ]
      : []),
  ]);
  const slash = useSlashMenu({
    scope: "workbench",
    target: session.sessionId ?? "welcome",
    textarea: input,
    draft,
    setDraft,
    disabled: chatOpen || settings || demo !== null || Boolean(pendingInput),
    state: composerState,
    backend,
    onPromptAction: (pluginId, actionId, title) =>
      setPromptRequest({ pluginId, actionId, title, nonce: Date.now() }),
  });
  return (
    <div
      data-mode={chatOpen ? "chat" : "workbench"}
      className={`herta-shell herta-r3 herta-r10${collapsed ? " herta-focused" : ""}${readerOpen ? " herta-with-reader" : ""}`}
      style={
        {
          "--herta-sidebar-width": `${sidebarWidth}px`,
          "--herta-reader-width": `${readerWidth}%`,
        } as CSSProperties
      }
    >
      <header className="herta-title">
        <span className="herta-star" aria-hidden="true">
          <Icon name="spark" />
        </span>
        <strong>The Herta</strong>
        <ModeTabs chatOpen={chatOpen} selectMode={selectMode} />
        {appVersion && <small className="herta-version">v{appVersion}</small>}
      </header>
      <aside className="herta-sidebar" aria-label="项目与任务导航">
        <button
          type="button"
          disabled={Boolean(session.overlay) || operation}
          onClick={() => void create()}
        >
          <Icon name="plus" />
          <span className="herta-icon-label">新建任务</span>
        </button>
        <button type="button" onClick={() => void openProject()}>
          打开项目文件夹
        </button>
        {navigation ? (
          <ProjectSidebar
            visible={!chatOpen && !collapsed}
            view={navigation}
            sessions={sessions}
            activeSessionId={session.sessionId}
            busy={busy || operation || Boolean(session.overlay)}
            onOpen={(id) => void open(id)}
            onCreate={(project) => {
              setWorkspace(project.path ?? "");
              void create(false, project.path);
            }}
            onUpdate={updateNavigation}
            onRelocateProject={async (projectId) => {
              const path = await bridge.pickWorkspace();
              if (path) {
                await updateNavigation({
                  kind: "relocate-project",
                  projectId,
                  path,
                });
                setNotice(
                  "项目位置已更新，新任务使用新位置；已有任务保留原执行目录，不会自动迁移代码。",
                );
              }
            }}
            onRenameTask={async (id, title) => {
              const renamed = await bridge.renameSession?.(id, title);
              if (!renamed?.ok) throw new Error("任务名称未保存。");
              sessionStore.applyUserTitle(id, renamed.title, renamed.topics);
              await sessionListStore.refresh();
            }}
          />
        ) : (
          <>
            <p className="herta-project-name" title={workspace}>
              {session.backendWorkspaceIsDefault
                ? "临时工作区"
                : workspace
                  ? projectName(workspace)
                  : "尚未选择项目"}
            </p>
            {workspace && (
              <details className="herta-project-details">
                <summary>项目位置</summary>
                <p className="herta-path">{workspace}</p>
                <button
                  type="button"
                  aria-live="polite"
                  onClick={() =>
                    void Promise.resolve()
                      .then(() => navigator.clipboard.writeText(workspace))
                      .then(
                        () => setPathCopy("done"),
                        () => setPathCopy("failed"),
                      )
                  }
                >
                  {pathCopy === "done"
                    ? "已复制项目路径"
                    : pathCopy === "failed"
                      ? "未能复制，请手动选择上方路径"
                      : "复制项目路径"}
                </button>
              </details>
            )}
            {recent.length > 0 && (
              <details>
                <summary>最近项目</summary>
                {recent.map((path) => (
                  <button
                    type="button"
                    className="herta-path"
                    key={path}
                    title={path}
                    onClick={() => {
                      setWorkspace(path);
                      setError("最近项目已选定，点击新建任务使用此目录。");
                    }}
                  >
                    {projectName(path)}
                  </button>
                ))}
              </details>
            )}
            <h2>任务历史</h2>
            {sessions.length === 0 && <p>暂无已保存任务</p>}
            {sessions.map((item) => (
              <div className="herta-history" key={item.sessionId}>
                <button
                  type="button"
                  disabled={Boolean(session.overlay) || operation}
                  aria-current={
                    session.sessionId === item.sessionId ? "page" : undefined
                  }
                  title={`${item.title || item.lastUserText || "未命名任务"}\n${item.workspaceRoot}`}
                  onClick={() => void open(item.sessionId)}
                >
                  {item.title ||
                    item.lastUserText?.slice(0, 45) ||
                    "未命名任务"}
                </button>
                {bridge.renameSession && (
                  <details className="herta-task-actions">
                    <summary
                      aria-label={`任务操作 ${item.title || "未命名任务"}`}
                      title="任务操作"
                    >
                      <Icon name="more" />
                    </summary>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`重命名 ${item.title || item.sessionId}`}
                      onClick={() => {
                        setRename(item.sessionId);
                        setRenameTitle(item.title ?? "");
                      }}
                    >
                      重命名
                    </button>
                  </details>
                )}
              </div>
            ))}
          </>
        )}
        {rename && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveName();
            }}
          >
            <label htmlFor="herta-rename">任务名称</label>
            <input
              id="herta-rename"
              value={renameTitle}
              onChange={(event) => setRenameTitle(event.target.value)}
              maxLength={160}
            />
            <button type="submit">保存名称</button>
            <button type="button" onClick={() => setRename(null)}>
              取消改名
            </button>
          </form>
        )}
        {demo && (
          <details>
            <summary>界面演示（独立，不执行工具）</summary>
            {(["chat", "approval", "diff"] as const).map((view) => (
              <button type="button" key={view} onClick={() => setDemo(view)}>
                {view === "chat"
                  ? "聊天与工具样例"
                  : view === "approval"
                    ? "审批样例"
                    : "只读变更样例"}
              </button>
            ))}
          </details>
        )}
        <button
          type="button"
          className="herta-settings-button"
          onClick={() => openSettings()}
        >
          设置
        </button>
      </aside>
      {/* biome-ignore lint/a11y/useSemanticElements: the keyboard-adjustable splitter requires value semantics. */}
      <div
        className="herta-resizer"
        role="separator"
        aria-label="导航宽度"
        aria-orientation="vertical"
        aria-valuenow={sidebarWidth}
        aria-valuemin={200}
        aria-valuemax={300}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            setSidebarWidth((value) =>
              Math.max(
                200,
                Math.min(300, value + (event.key === "ArrowLeft" ? -10 : 10)),
              ),
            );
          }
        }}
        onPointerDown={(event) =>
          event.currentTarget.setPointerCapture(event.pointerId)
        }
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            setSidebarWidth(Math.max(200, Math.min(300, event.clientX)));
        }}
        onPointerUp={(event) =>
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      />
      <main
        ref={main}
        className="herta-main"
        id="herta-workbench-panel"
        role="tabpanel"
        aria-labelledby="herta-workbench-tab"
      >
        <div className="herta-toolbar">
          <button
            type="button"
            aria-label={collapsed ? "展开导航" : "收起导航"}
            onClick={() => setCollapsed((value) => !value)}
          >
            <Icon name="sidebar" />
          </button>
          <h1 className="herta-task-title" title={session.title ?? undefined}>
            {demo
              ? "界面演示"
              : session.title ||
                sessions.find((item) => item.sessionId === session.sessionId)
                  ?.title ||
                sessions
                  .find((item) => item.sessionId === session.sessionId)
                  ?.lastUserText?.slice(0, 45) ||
                (session.sessionId ? "未命名任务" : "新任务")}
          </h1>
          <span className="herta-status">
            {pendingInput
              ? "等待你的回答"
              : busy
                ? overlay
                  ? "等待审批"
                  : "请求处理中"
                : session.sessionId
                  ? failure || error || session.turnFailed
                    ? "需要处理"
                    : readiness && !readiness.ready
                      ? "待完成配置"
                      : "就绪"
                  : "尚未创建任务"}
          </span>
          <button
            type="button"
            onClick={() => setReviewOpen((value) => !value)}
            aria-expanded={reviewOpen}
          >
            工作区审阅
          </button>
          {demo && (
            <button type="button" onClick={() => setDemo(null)}>
              返回真实任务
            </button>
          )}
        </div>
        {navigationTarget !== undefined && (
          <section className="herta-approval" aria-label="切换任务确认">
            <h2>停止当前输出并切换任务？</h2>
            <p>
              切换会中断当前请求和正在运行的工具；记录、文件改动与草稿都会保留。
              {session.overlay ? "请先处理当前审批，再切换。" : ""}
            </p>
            <div className="herta-actions">
              <button
                type="button"
                disabled={operation || Boolean(session.overlay)}
                onClick={() => {
                  const target = navigationTarget;
                  setNavigationTarget(undefined);
                  if (target === null) void create(true);
                  else void open(target, true);
                }}
              >
                停止并切换
              </button>
              <button
                type="button"
                onClick={() => setNavigationTarget(undefined)}
              >
                留在当前任务
              </button>
            </div>
          </section>
        )}
        <div className="herta-content" ref={content}>
          {demo ? (
            <DemoPanel key={demo} view={demo} />
          ) : !session.sessionId ? (
            <section className="herta-welcome herta-welcome-illustrated">
              <div className="herta-welcome-copy">
                <span className="herta-star" aria-hidden="true">
                  <Icon name="spark" />
                </span>
                <p className="herta-eyebrow">THE HERTA / WORKBENCH</p>
                <h2>把难题拿来，别让我无聊。</h2>
                <p>
                  选好项目，我们就开始。还没准备目录？也可以先在独立工作区试试。
                </p>
                <div className="herta-actions">
                  <button type="button" onClick={() => void openProject()}>
                    打开项目文件夹
                  </button>
                  <button type="button" onClick={() => openSettings(true)}>
                    连接与模型
                  </button>
                </div>
              </div>
              <div className="herta-welcome-art" aria-hidden="true">
                <img
                  src={welcomePortrait}
                  alt=""
                  draggable={false}
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                />
              </div>
            </section>
          ) : (
            <section className="herta-transcript" aria-label="任务记录">
              <details className="herta-session-details">
                <summary>任务详情</summary>
                <p className="herta-path">
                  任务 ID：{session.sessionId}
                  <br />
                  工作目录：{session.backendWorkspace}
                </p>
              </details>
              {session.recordStart > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    void sessionStore
                      .loadOlderBlocks()
                      .catch(() => setError("较早记录读取失败。"))
                  }
                >
                  加载较早记录
                </button>
              )}
              {[
                {
                  id: "legacy",
                  start: session.recordStart,
                  end:
                    rounds[0]?.recordStart ??
                    session.recordStart + session.record.length,
                  round: null,
                },
                ...rounds.map((round, index) => ({
                  id: round.id,
                  start: Math.max(round.recordStart, session.recordStart),
                  end:
                    rounds[index + 1]?.recordStart ??
                    session.recordStart + session.record.length,
                  round,
                })),
              ]
                .filter(
                  (group) =>
                    group.end >= group.start &&
                    (group.end > group.start ||
                      group.round?.status === "running"),
                )
                // One flat list keyed by record offset and round id, so the
                // regrouping when round results arrive or a round starts keeps
                // rows mounted: selection, focus and a running entrance
                // survive it (R71).
                .flatMap((group) => [
                    ...session.record
                      .slice(
                        group.start - session.recordStart,
                        group.end - session.recordStart,
                      )
                      .map((block, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: absolute append-only record offsets.
                        <Fragment key={group.start + index}>
                          {!(
                            // Shown in its message's bubble instead (R79).
                            attached.owner.has(group.start - session.recordStart + index) ||
                            (block.kind === "herta" &&
                              block.surface === "thought") ||
                            (group.round &&
                              group.round.activities.length > 0 &&
                              block.kind === "system" &&
                              !block.recoverySummary &&
                              !block.evidenceDetail &&
                              (block.label === "差分协处理器" ||
                                block.body.startsWith("patch preview:")))
                          ) && (
                            <article
                              className={
                                block.kind === "user" ? "herta-user" : ""
                              }
                              data-entrance={
                                block.kind === "user"
                                  ? String(group.start + index)
                                  : undefined
                              }
                            >
                              <strong>
                                {block.kind === "user"
                                  ? "你"
                                  : block.kind === "herta"
                                    ? "黑塔"
                                    : block.label}
                              </strong>
                              <MessageTime at={block.at} />
                              {block.kind === "user" &&
                                attached.rows.has(group.start - session.recordStart + index) && (
                                  <AttachmentTray
                                    label="这条消息的附件"
                                    items={attachmentsOf(group.start - session.recordStart + index)}
                                    {...pictureUseFor(group.start - session.recordStart + index)}
                                  />
                                )}
                              <MessageContent
                                text={
                                  block.kind === "system"
                                    ? // Display-only, in the session's language like other record rows; the record keeps its body (R67).
                                      stepDisplayBody(block, recordT)
                                    : block.text
                                }
                              />
                              {block.kind === "system" &&
                                block.recoverySummary && (
                                  <RecoveryFacts
                                    facts={block.recoverySummary}
                                  />
                                )}
                              {block.kind === "system" &&
                                block.evidenceDetail && (
                                  <EvidenceDetail text={block.evidenceDetail} />
                                )}
                            </article>
                          )}
                        </Fragment>
                      )),
                    group.round && (
                      <RoundResults
                        key={`round:${group.id}`}
                        round={group.round}
                        onRead={(roundId, fileId, line) =>
                          void openRoundFile(roundId, fileId, line)
                        }
                        loadFile={loadRoundFile}
                      />
                    ),
                  ])}
              {roundsError && (
                <p className="herta-rounds-error" role="status">
                  本轮结果暂时无法读取，已有对话保留。
                </p>
              )}
              {session.streamingText !== null && (
                <article>
                  <strong>黑塔 · 正在输出</strong>
                  <MessageContent text={session.streamingText} streaming />
                </article>
              )}
              {session.live.views.length > 0 &&
                !rounds.some((round) => round.activities.length > 0) && (
                  <details>
                    <summary>工具活动 · {session.live.views.length}</summary>
                    {session.live.views.map((tool) => (
                      <article key={tool.id}>
                        <strong>
                          {tool.tool} ·{" "}
                          {tool.done
                            ? tool.ok
                              ? "完成"
                              : "失败"
                            : tool.stage === "running"
                              ? "执行中"
                              : "参数生成中"}
                        </strong>
                        <p>{tool.summary || tool.commandLine || tool.path}</p>
                        {tool.path && (
                          <p className="herta-path">目标路径：{tool.path}</p>
                        )}
                        {tool.commandLine && tool.summary && (
                          <pre>{tool.commandLine}</pre>
                        )}
                        <pre>{tool.tail}</pre>
                      </article>
                    ))}
                  </details>
                )}
              {session.resumable && (
                <div>
                  <p role="status">
                    上次运行中断了。继续时会重新请求模型并沿用已保存的工具结果，已完成的操作不会再执行。
                  </p>
                  {bridge.continueInterrupted && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void resume()}
                    >
                      继续中断的任务
                    </button>
                  )}
                </div>
              )}
              {reviewOpen && (
                <details className="herta-review-panel" open>
                  <summary>项目文件与只读 diff</summary>
                  <label htmlFor="herta-file">工作区内相对路径</label>
                  <input
                    id="herta-file"
                    value={filePath}
                    onChange={(event) => setFilePath(event.target.value)}
                  />
                  <div className="herta-actions">
                    <button type="button" onClick={() => void readFile(false)}>
                      读取文件
                    </button>
                    <button type="button" onClick={() => void readFile(true)}>
                      读取磁盘 diff
                    </button>
                  </div>
                  <p>显示当前磁盘相对 HEAD 的差异，仅供查看。</p>
                  {fileResult && fileResult.sessionId === session.sessionId && (
                    <div>
                      <strong>{fileResult.path}</strong>
                      <pre>{fileResult.text}</pre>
                    </div>
                  )}
                </details>
              )}
            </section>
          )}
          {errorCardText !== null && (
            <section role="alert" className="herta-error-card">
              <p>{errorCardText}</p>
              {visibleFailure?.action === "goal" && (
                <button
                  type="button"
                  disabled={!goal.available}
                  onClick={goal.open}
                >
                  查看目标
                </button>
              )}
              {visibleFailure?.action !== "attachment" &&
                visibleFailure?.action !== "goal" && (
                  <button type="button" onClick={() => openSettings(true)}>
                    完成配置 / 验证模型
                  </button>
                )}
              {visibleFailure && (
                <details>
                  <summary>诊断详情</summary>
                  <p>
                    {visibleFailure.code} · {visibleFailure.stage}
                    {visibleFailure.status
                      ? ` · HTTP ${visibleFailure.status}`
                      : ""}
                  </p>
                </details>
              )}
              {visibleFailure?.action === "retry" && (
                <p>
                  草稿保留，确认连接后可再次发送；不会重复执行工具。
                </p>
              )}
            </section>
          )}
          {!demo && relocatedPath && (
            <section className="herta-error-card" aria-label="项目位置已变更">
              <p>项目位置已变更，当前任务仍使用原执行目录。</p>
              <details>
                <summary>目录详情</summary>
                <p className="herta-path">原目录：{session.backendWorkspace}</p>
                <p className="herta-path">新目录：{relocatedPath}</p>
              </details>
              <button
                type="button"
                disabled={busy || operation || Boolean(session.overlay) || attachReading.length > 0}
                onClick={() => void switchToProjectLocation()}
              >
                使用项目新位置
              </button>
            </section>
          )}
          {/* In the reading column, like the error cards above it (R79). */}
          {notice && (
            <p className="herta-notice" role="status">
              {notice}
            </p>
          )}
          {/* Floats over the transcript's foot (sticky), so showing it never
              shifts the layout under the reader (R44). */}
          {tail.away && !demo && session.sessionId && (
            <button type="button" ref={latest} className="herta-latest" onClick={tail.jump}>
              回到最新
            </button>
          )}
        </div>
        {!demo && pendingInput && bridge.answerUserInput && (
          <UserInputCard
            key={pendingInput.requestId}
            request={pendingInput}
            onAnswer={async (answer) => {
              const result = (await bridge.answerUserInput?.(answer)) ?? {
                accepted: false,
              };
              if (
                result.accepted &&
                !result.deferred &&
                activeId.current === answer.sessionId
              )
                setPendingInput(null);
              return result;
            }}
          />
        )}
        {!demo && overlay && (
          <section className="herta-approval" aria-label="真实执行审批">
            <h2>
              写入或执行前审批
              {permissionAsk && (
                <span
                  className={`herta-approval-risk${isDangerRisk(permissionAsk.risk) ? " is-danger" : ""}`}
                >
                  {askRiskKey ? t(askRiskKey) : permissionAsk.risk}
                </span>
              )}
            </h2>
            <div className="herta-approval-body">
              {permissionAsk && (
                <p className="herta-approval-reason">
                  {askReasonKey ? t(askReasonKey) : permissionAsk.summary}
                </p>
              )}
              {overlay.command && <pre>{overlay.command}</pre>}
              {askNotes.map((note) => (
                <p key={note} className="herta-approval-note">
                  {note}
                </p>
              ))}
              {permissionAsk?.files && (
                <p className="herta-path">
                  目标文件：{permissionAsk.files.join("、")}
                </p>
              )}
              {permissionAsk?.diff && (
                <details>
                  <summary>待写入 diff（尚未执行）</summary>
                  <pre>{permissionAsk.diff}</pre>
                </details>
              )}
              <p className="herta-path">工作目录：{session.backendWorkspace}</p>
              <details className="herta-approval-diagnostics">
                <summary>诊断信息</summary>
                <p className="herta-path">
                  任务：{session.sessionId}
                  <br />
                  请求：{overlay.requestId}
                  {permissionAsk && (
                    <>
                      <br />
                      工具：{permissionAsk.tool} · 风险代码：
                      {permissionAsk.risk}
                      {permissionAsk.code ? ` · ${permissionAsk.code}` : ""}
                      <br />
                      规则原文：{permissionAsk.summary}
                    </>
                  )}
                </p>
              </details>
            </div>
            <div className="herta-actions">
              <button
                type="button"
                disabled={resolving}
                onClick={() => void approve("allow")}
              >
                允许本次
              </button>
              <button
                type="button"
                disabled={resolving}
                onClick={() => void approve("deny")}
              >
                拒绝
              </button>
              <button type="button" onClick={() => void cancel()}>
                取消本轮
              </button>
            </div>
          </section>
        )}
        <footer className="herta-composer">
          <GoalStrip goal={goal} />
          <PlanStrip plan={plan} />
          <CompactStrip compact={compact} />
          {/* A warning card above the box, beside the choice it confirms; it
              used to trail the metrics row as bare text (R45). */}
          {fullAccessChoice && (
            <FullAccessConfirmation
              onConfirm={() => void choosePermission("full-access", true)}
              onCancel={() => setFullAccessChoice(false)}
            />
          )}
          <label className="herta-draft-label" htmlFor="herta-draft">
            任务草稿 · 保存在本机
          </label>
          <div
            className={`herta-composer-box${dragOver ? " is-dragover" : ""}`}
            {...dropHandlers}
          >
            {session.stagedImageError && (
              <div role="alert" className="herta-notice herta-recovery">
                <p>{session.stagedImageError}</p>
                {bridge.resetPendingImages && resetAsk && (
                  <p>重置会把损坏的清单改名另存，不删除任何图片文件；清单里原有的待发图片不会恢复，需要时请重新添加。</p>
                )}
                {bridge.resetPendingImages && (
                  <div className="herta-actions">
                    {resetAsk ? (
                      <>
                        <button type="button" ref={resetConfirm} disabled={resetting || busy} onClick={() => void resetPendingManifest()}>
                          确认重置清单
                        </button>
                        <button type="button" disabled={resetting} onClick={() => setResetAsk(false)}>
                          取消
                        </button>
                      </>
                    ) : (
                      <button type="button" ref={resetOffer} disabled={busy || operation} onClick={() => setResetAsk(true)}>
                        重置待发图片清单…
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            {docStorageError && <p role="alert" className="herta-notice">{docStorageError}</p>}
            {attachError && <p role="alert" className="herta-notice">{attachError}</p>}
            {backend.notice && (
              <p
                role={backend.notice.error ? "alert" : "status"}
                className="herta-notice"
              >
                {backend.notice.text}
              </p>
            )}
            <AttachmentTray
              label="待发送的附件"
              items={pendingItems}
              disabled={busy || operation}
              onRemove={removePendingAttachment}
              onCancel={(key) => {
                cancelledAttach.current.add(key.slice(2));
                // R118: stop the read and the copy in the main process, not only the card.
                if (session.sessionId)
                  void bridge
                    .cancelStaging?.(session.sessionId, key.slice(2))
                    .catch(() => undefined);
                setAttachReading((r) => r.filter((x) => x.id !== key.slice(2)));
                if (session.sessionId) keepIssues(session.sessionId, (list) => list.filter((i) => i.id !== key.slice(2)));
              }}
              onRetry={(key) => {
                const failed = attachFailed.find((f) => f.id === key.slice(2));
                const id = session.sessionId;
                if (!failed || !id || failed.retry === false) return;
                setAttachFailed((list) => list.filter((f) => f !== failed));
                keepIssues(id, (list) => list.filter((i) => i.id !== failed.id));
                void addAttachments(id, [failed.input]);
              }}
            />
            {slash.menu}
            <textarea
              id="herta-draft"
              ref={input}
              value={draft}
              {...slash.textareaProps}
              onPaste={onComposerPaste}
              onBlur={slash.close}
              onChange={(event) => {
                setDraft(event.target.value);
                slash.onChange(event.target.value, event.target.selectionStart);
              }}
              placeholder="描述希望处理的问题… Ctrl+Enter 发送，Enter 换行"
              onKeyDown={(event) => {
                if (slash.onKeyDown(event)) return;
                if (
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229 &&
                  event.key === "Enter" &&
                  (event.ctrlKey || event.metaKey)
                ) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="herta-composer-controls">
              <PromptActionPicker
                onOpenOutputs={() => { closeReader(); setPluginFilesOwner(session.sessionId); }}
                suspended={Boolean(overlay)}
                scope="workbench"
                target={draftKey}
                draft={draft}
                draftRevision={draftVersion.current.revision}
                executionTarget={session.sessionId ?? ""}
                disabled={
                  chatOpen ||
                  settings ||
                  busy ||
                  operation ||
                  demo !== null ||
                  Boolean(pendingInput)
                }
                state={composerState}
                backend={backend}
                request={promptRequest}
                onInsert={(text, expectedRevision?: number) => {
                  if (expectedRevision !== undefined && draftVersion.current.revision !== expectedRevision) return false;
                  setDraft(text);
                  input.current?.focus({ preventScroll: true });
                  return true;
                }}
              />
              <button
                type="button"
                className="herta-attach"
                aria-label="添加文件"
                title="添加文件：随下一条消息发送（也可粘贴截图或拖入文件）"
                disabled={
                  !session.sessionId ||
                  busy ||
                  operation ||
                  Boolean(pendingInput) ||
                  attachReading.length > 0
                }
                onClick={async () => {
                  const id = session.sessionId;
                  if (!id) return;
                  const pickerRevision = sessionRevision.current;
                  const paths = await bridge.pickAttachments();
                  if (!paths?.length || activeId.current !== id || sessionRevision.current !== pickerRevision) return;
                  await addAttachments(id, paths.map(attachInputFromPath));
                }}
              >
                <Icon name="attach" />
              </button>
              {permission && (
                <>
                  <label className="herta-permission-control">
                    <select
                      className="herta-permission-select"
                      aria-label="权限档位"
                      disabled={!permission.sessionId || plan.locked || permission.planLocked}
                      value={plan.locked || permission.planLocked ? "read-only" : permission.mode}
                      title={plan.locked || permission.planLocked ? "计划模式中，权限保持只读" : undefined}
                      onChange={(event) =>
                        void choosePermission(
                          event.target.value as PermissionMode,
                        )
                      }
                    >
                      <option value="read-only">只读 / 讨论</option>
                      <option value="workspace-edit">工作区编辑</option>
                      <option value="full-access">完全访问</option>
                    </select>
                  </label>
                  <WorkbenchSearch readiness={readiness} sessionId={session.sessionId} busy={busy} refresh={refreshWorkbench} />
                  <details className="herta-composer-options" onKeyDown={closeDetailsOnEscape}>
                    <summary title="权限应用范围" aria-label="权限应用范围选项">
                      <Icon name="more" />
                    </summary>
                    <label>
                      权限继承
                      <select
                        aria-label="权限应用范围"
                        disabled={plan.locked || permission.planLocked}
                        value={permissionScope}
                        onChange={(e) =>
                          setPermissionScope(
                            e.target.value as "session" | "project",
                          )
                        }
                      >
                        <option value="session">当前任务</option>
                        <option value="project">项目默认与当前任务</option>
                      </select>
                    </label>
                  </details>
                </>
              )}
              <details className="herta-send-help">
                <summary>发送说明</summary>
                <p>
                  {demo
                    ? "演示视图不能发送；返回真实任务后继续。"
                    : "Ctrl+Enter 发送 · 配置按每轮冻结 · 不自动重试"}
                </p>
              </details>
              {/* The model and the send action travel together at the row's
                  end, so a narrow column never strands ↑ on its own line (R45). */}
              <div className="herta-composer-send-group">
              <ComposerModelPicker
                readiness={readiness}
                sessionId={session.sessionId}
                busy={busy}
                refresh={refreshWorkbench}
                manage={() => openSettings(true)}
              />
              {pendingInput ? (
                <span role="status">等待你的回答</span>
              ) : busy ? (
                <button
                  className="herta-send-action"
                  aria-label="取消本轮"
                  title="取消本轮"
                  type="button"
                  onClick={() => void cancel()}
                >
                  <Icon name="stop" />
                </button>
              ) : (
                <button
                  type="button"
                  className="herta-send-action"
                  aria-label="发送"
                  title="发送 · Ctrl+Enter"
                  disabled={demo !== null || operation || !draft.trim()}
                  onClick={() => void submit()}
                >
                  <Icon name="send" />
                </button>
              )}
              </div>
            </div>
          </div>
          <RoundDashboard rounds={rounds} metrics={metrics} />
        </footer>
      </main>
      {readerOpen && (
        <>
          {/* biome-ignore lint/a11y/useSemanticElements: keyboard-adjustable splitter needs numeric ARIA values. */}
          <div
            className="herta-reader-resizer"
            role="separator"
            aria-label="阅读面板宽度"
            aria-orientation="vertical"
            aria-valuenow={readerWidth}
            aria-valuemin={30}
            aria-valuemax={65}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                setReaderWidth((value) =>
                  Math.max(
                    30,
                    Math.min(65, value + (event.key === "ArrowLeft" ? 2 : -2)),
                  ),
                );
              }
            }}
            onPointerDown={(event) =>
              event.currentTarget.setPointerCapture(event.pointerId)
            }
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                setReaderWidth(
                  Math.max(
                    30,
                    Math.min(
                      65,
                      (100 * (window.innerWidth - event.clientX)) /
                        window.innerWidth,
                    ),
                  ),
                );
            }}
            onPointerUp={(event) =>
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
          />
          <aside className="herta-reader-dock" aria-label="文件快照阅读">
            <RoundReader
              content={readerContent}
              loading={readerLoading}
              onClose={closeReader}
            />
          </aside>
        </>
      )}
      {chatVisited && (
        <HertaChat
          visible={chatOpen}
          settingsOpen={settings}
          onSettings={() => openSettings(true)}
        />
      )}
      <SettingsModal
        open={settings}
        {...(settingsPage ? { initialSection: settingsPage } : {})}
        onClose={() => setSettings(false)}
        {...(session.sessionId ? { sessionId: session.sessionId } : {})}
      />
      <PluginDeliverablesPanel scope="workbench" target={session.sessionId ?? ""} open={!!session.sessionId && pluginFilesOwner === session.sessionId} shown={!chatOpen && !settings} draftRevision={draftVersion.current.revision} getCurrentRevision={() => draftVersion.current.revision} onClose={() => setPluginFilesOwner(null)} />
      <FeedbackPanel request={feedbackRequest} />
      <GoalPanel goal={goal} />
      <PlanPanel plan={plan} />
      <WorkbenchCompactPanel compact={compact} />
    </div>
  );
}








