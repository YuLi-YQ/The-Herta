import { PluginDeliverablesPanel } from "./Plugins/PluginDeliverablesPanel.js";
import { PromptActionPicker } from "./Plugins/PromptActionPicker.js";
import { webSearchSupport } from "@herta/providers/web-search";
import { SearchToggle, SearchResults } from "./WebSearch.js";
import { reasoningChoices } from "@herta/providers/reasoning";
import { imageSupport, imageDataURL } from "@herta/providers/images";
import { type ClipboardEvent, type DragEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  validateChatAttachments,
  type ChatAttachment,
  chatFailures,
  chatOutputBudgets,
  defaultChatOutputBudget,
  type HertaChatAction,
  type HertaChatSnapshot,
} from "../../shared/herta-chat.js";
import { useHertaBridge } from "../context/HertaBridgeContext.js";
import { useFollowOutput } from "../hooks/useFollowOutput.js";
import { useResponsiveSidebar } from "../hooks/useResponsiveSidebar.js";
import { WaitingStatus } from "./WaitingStatus.js";
import { MessageContent } from "./MessageContent.js";
import { MessageTime } from "./MessageTime.js";
import { AttachmentTray, type TrayItem } from "./AttachmentTray.js";
import { useSlashMenu } from "./SlashMenu.js";
import {
  exportCommand,
  feedbackCommand,
  goalCommand,
  compactCommand,
  useBackendCommands,
} from "./ComposerActions.js";
import { buildChatMarkdown } from "./ChatMarkdown.js";
import {
  type FeedbackContext,
  FeedbackPanel,
  type FeedbackRequest,
} from "./FeedbackPanel.js";
import { ChatContextPanel, useChatContext } from "./ChatContextPanel.js";
import { GoalPanel, GoalStrip, useGoalController } from "./GoalPanel.js";
import { formatStamp } from "./Sidebar/session-markdown.js";
import {
  ChatFileText,
  ChatMessageAttachments,
  chatFileMeta,
} from "./ChatAttachmentPreview.js";
import { ChatStorage } from "./ChatStorage.js";
import { ChatMemory } from "./ChatMemory.js";
import { ChatSidebar } from "./ChatSidebar.js";
import { ChatModelPicker } from "./ChatModelPicker.js";
import { Icon } from "./Icon.js";
import {
  useAppendEntrance,
  useEntrance,
  useSwitchEntrance,
} from "../lib/gsap-motion.js";
import { pendingChatStore, type PendingChatProblem } from "../lib/pending-chat-attachments.js";
import { readAttachIssues, writeAttachIssues } from "../lib/pending-attach-issues.js";
import "../styles/herta-chat.css";

const empty: HertaChatSnapshot = {
  revision: -1,
  activeId: null,
  chats: [],
  messages: [],
  contextStart: 0,
  contextNote: "",
  contextCharacters: 0,
  busy: false,
  error: null,
};
const draftKey = (id: string) => `the-herta.chat-draft.v2.${id}`;
const modelKey = (id: string) => `the-herta.chat-model.v2.${id}`;
/** One wording for the warning shown before sending and the failure after it (R72). */
const IMAGE_UNSUPPORTED =
  "当前模型未通过识图检测，图片不会发出。可在“连接与模型”中点“测试识图”，或换用已通过的模型；也可移除附件、调整续聊范围，或在已发送的图片下选择“不再发给模型”。";
/** What a chat says about the pending files it keeps on this computer (R101): why they are not,
 *  or may not be, kept — or that the files a restart brought back look already sent. */
type PendingIssue = "unreadable" | "unavailable" | "not_saved" | "maybe_sent";
const PENDING_ISSUES: Record<PendingIssue, string> = {
  unreadable:
    "上次未发送的附件记录无法读取（可能已损坏或来自其他版本），原记录已保留。重置会把它另存、不删除，其中的附件不会恢复；重置前，这个聊天新添加的附件只保存在本次运行中。",
  unavailable:
    "无法读取本机保存的待发附件，原记录未改动，下次启动会再尝试；本次添加的附件只保存在本次运行中。",
  not_saved:
    "待发附件的更改未能保存到本机：重启后附件可能恢复为更早的状态（包括已移除或已发送的），请核对后再发送。",
  maybe_sent:
    "恢复的附件与上一条已发送消息的附件相同，可能已随那条消息发出。如不需要再次发送，请移除它们。",
};
const RESTORED_UNSEEN = "已恢复上次未发送的附件，请确认后再发送。";
/** A file that has not become an attachment (R78): being read, refused, or cut short. Each
 *  stays on record with its chat until it is added or removed (R102), so a switch or a
 *  restart never leaves a file out silently. The record keeps the name and the reason; the
 *  File, which a retry reads again, lasts only for this run. */
interface FileCard {
  readonly id: string;
  readonly name: string;
  /** Why it was refused; absent while it is, or last was, being read. */
  readonly error?: string;
  readonly file?: File;
  /** Read into an attachment that is still being saved: out of the tray, still on record. */
  readonly settling?: true;
}
/** Why the chat's card record could not be kept (R102); a refused overwrite is "unreadable". */
type CardProblem = "unreadable" | "not_saved";
const CARD_PROBLEMS: Record<CardProblem, string> = {
  unreadable:
    "未添加成功的附件记录无法读取，原记录已保留、不会被覆盖；这个聊天的此类卡片只在本次运行中保留。",
  not_saved: "未添加成功的附件记录保存失败，当前卡片只在本次运行中保留。",
};
/** What a card says beside its name: the reason, and what is left to do. */
function cardError(card: FileCard): string {
  if (card.file) return card.error ?? "读取没有完成，请重试或移除。";
  // A restart kept the name and the reason, never the file: nothing is left to retry with.
  const reason = card.error ?? "上次关闭前还没读取完成。";
  return `${reason}${/[。！？.!?]$/.test(reason) ? "" : "。"}应用重启后无法直接重试，需要时请重新添加。`;
}
/** A per-chat note set, or cleared with null; the same object when nothing changed. */
function noted<T>(all: Record<string, T>, chatId: string, value: T | null) {
  if ((all[chatId] ?? null) === value) return all;
  const next = { ...all };
  if (value !== null) next[chatId] = value;
  else delete next[chatId];
  return next;
}
/** Whether restored files are the ones the newest sent message carried: what an exit between
 *  saving that message and clearing the files leaves. History pictures reach the window without
 *  their bytes, so a picture matches by name. */
function sameAsSent(files: readonly ChatAttachment[], sent: readonly ChatAttachment[] = []) {
  return (
    files.length > 0 &&
    files.length === sent.length &&
    files.every((file, i) => {
      const other = sent[i];
      return (
        other !== undefined &&
        file.name === other.name &&
        file.text === other.text &&
        file.format === other.format &&
        !file.image === !(other.image || other.imageDeferred || other.imageRef)
      );
    })
  );
}
function safeError(error: unknown): string {
  const value = String(error);
  return (
    [
      "存储用量暂时无法读取，请稍后刷新。",
      "聊天已切换，请在当前聊天重新发送。",
      "当前模型不支持所选思考强度，请重新选择。",
      "续聊上下文已满，请调整续聊范围或新建聊天；原文仍保留。",
      "续聊图片较多（每次最多8张、共12 MiB），可在图片下选择“不再发给模型”，或减少续聊范围、新建聊天；原图仍保留。",
      "续聊中有缺失或损坏的图片，请恢复图片目录、调整续聊范围，或在该图片下选择“不再发给模型”。",
      IMAGE_UNSUPPORTED,
      "当前连接或模型尚不支持联网搜索。",
      "请重新上传图片文件。",
      "保留的内容仍然过长，请选择更少轮次。",
      "名称需为1至80个字符。",
      "聊天数量达到本版上限，回收区仍计入总量。",
      "请先在连接设置中验证所选模型的文本能力。",
      "聊天操作未保存，原记录保持不变。",
      "聊天记录未能保存，消息尚未发送。",
      "请等待回复结束或先停止，再管理聊天。",
    ].find((text) => value.includes(text)) ??
    "操作未完成，请检查连接与模型设置；记录和草稿已保留。"
  );
}
/** F04 (R117): why a picture switch did not change, said under that message's pictures. */
function pictureUseError(error: unknown): string {
  const value = String(error);
  return value.includes("这些图片已经变化")
    ? "这条消息的图片已经变化，请重试。"
    : value.includes("请等待回复结束")
      ? "黑塔正在回复，结束后再更改。"
      : "未能更改图片的发送设置，请重试。";
}
/** Image cleanup messages the main process may show as-is; anything else stays generic. */
function cleanupError(error: unknown): string {
  const value = String(error);
  return [
    "部分记录或文件无法检查，暂不能清理图片。",
    "清理预览已过期，请重新预览。",
    "隔离批次无效。",
    "隔离批次不存在。",
    "恢复后图片库会超过 256 MB 上限，请先备份或清理其他图片。",
    "图片目录无效，暂不能清理。",
    "请等待回复结束或先停止，再管理聊天。",
  ].find((text) => value.includes(text)) ??
    "图片整理未完成，请刷新存储空间查看当前状态；已移入隔离区的图片可以恢复。";
}
/** Memory messages the main process may show as-is; anything else stays generic. */
function memoryError(error: unknown): string {
  const value = String(error);
  return [
    "这条记忆已不存在。",
    "记忆已满，请先整理已有条目。",
    "每条记忆需为1至500字。",
    "记忆文件过大，原文件已保留。",
    "记忆文件无法读取，原文件已保留。",
  ].find((text) => value.includes(text)) ??
    "记忆更改未保存，原有记忆保持不变。";
}
export function HertaChat({
  visible = true,
  settingsOpen = false,
  onSettings,
}: {
  visible?: boolean;
  settingsOpen?: boolean;
  onSettings: () => void;
}) {
  const { bridge } = useHertaBridge();
  const lastActivity = useRef(0);
  const noteActivity = () => {
    if (Date.now() - lastActivity.current < 10000) return;
    lastActivity.current = Date.now();
    void Promise.resolve(bridge.manageHertaChat?.({ type: "activity" })).catch(
      () => {},
    );
  };
  const scroller = useRef<HTMLDivElement>(null);
  const tail = useFollowOutput(scroller, 60);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [state, setState] = useState<HertaChatSnapshot>(empty);
  const activeRef = useRef<string | null>(null);
  const [pluginFilesOwner, setPluginFilesOwner] = useState<string | null>(null);
  useEffect(() => { setPluginFilesOwner(null); }, [state.activeId, visible, settingsOpen]);
  const [draft, updateDraft] = useState("");
  const draftVersion = useRef({ text: draft, revision: 0 });
  const setDraft = (value: string | ((current: string) => string)) => {
    const text = typeof value === "function" ? value(draftVersion.current.text) : value;
    if (text === draftVersion.current.text) return;
    draftVersion.current = { text, revision: draftVersion.current.revision + 1 };
    updateDraft(text);
  };
  const [webSearch, setWebSearch] = useState(false);
  useEffect(() => { setWebSearch(!!state.activeId && localStorage.getItem(`the-herta.chat-search.${state.activeId}`) === "true"); }, [state.activeId]);
  const [importing, setImporting] = useState(false);
  const importGeneration = useRef(0);
  // Each file being read, and each that could not be added, has its own card in
  // the composer (R78): a reading one can be cancelled — its late result is then
  // dropped — and a failed one retried or removed. Both belong to the chat that
  // started the import, like the import itself. Since R102 a switch or a restart
  // keeps them (see FileCard): a read the switch cut short comes back as a card
  // to retry, and the late result still goes nowhere.
  const [reading, setReading] = useState<{ id: string; name: string }[]>([]);
  const cancelledFiles = useRef(new Set<string>());
  /** The card whose file the main process is reading now (R118): a cancel, a switch or
   *  closing the chat tells it to stop, rather than only dropping the late result. */
  const parsingFile = useRef<string | null>(null);
  const stopParsing = () => {
    const job = parsingFile.current;
    if (job) void bridge.cancelChatFile?.(job).catch(() => undefined);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: stopParsing reads refs only; this runs on unmount.
  useEffect(() => stopParsing, []);
  const cardsByChat = useRef(new Map<string, FileCard[]>());
  const [cards, setCards] = useState<FileCard[]>([]);
  const [cardProblems, setCardProblems] = useState<Record<string, CardProblem>>({});
  /** A chat's cards. Its record is read once per launch, before anything may write it. */
  const chatCards = (chatId: string): FileCard[] => {
    let list = cardsByChat.current.get(chatId);
    if (!list) {
      const saved = readAttachIssues(chatId, "chat");
      list = saved.issues.map(({ id, name, error }) => ({ id, name, ...(error === undefined ? {} : { error }) }));
      cardsByChat.current.set(chatId, list);
      if (saved.error) setCardProblems((all) => noted(all, chatId, "unreadable"));
    }
    return list;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatCards reads a chat once per launch; only a newly active chat is shown.
  useEffect(() => {
    importGeneration.current++;
    stopParsing();
    setImporting(false);
    setReading([]);
    setCards(state.activeId ? chatCards(state.activeId) : []);
  }, [state.activeId]);
  /** Changes a chat's cards and keeps their record: names and reasons, never the File. */
  const keepCards = (chatId: string, change: (list: FileCard[]) => FileCard[]) => {
    const next = change(chatCards(chatId));
    cardsByChat.current.set(chatId, next);
    if (activeRef.current === chatId) setCards(next);
    const problem = writeAttachIssues(chatId, next, "chat");
    const kept: CardProblem | null = !problem ? null : problem === "not_saved" ? "not_saved" : "unreadable";
    setCardProblems((all) => noted(all, chatId, kept));
  };
  // Pending files stay with their chat, like drafts, until that chat sends
  // them (R70). Since R101 they are kept on this computer too, so a restart
  // brings them back.
  const pendingFiles = useRef(new Map<string, ChatAttachment[]>());
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [pendingStore] = useState(() => pendingChatStore());
  // A chat reads its saved files once per launch, before anything changes them, and is
  // saved only after that read succeeded: a record it could not read is never replaced.
  const restoring = useRef(new Map<string, Promise<void>>());
  const saving = useRef(new Set<string>());
  const [pendingIssues, setPendingIssues] = useState<Record<string, PendingIssue>>({});
  const [resettingPending, setResettingPending] = useState(false);
  const notePendingIssue = (chatId: string, issue: PendingIssue | null) =>
    setPendingIssues((all) => noted(all, chatId, issue));
  const restorePending = (chatId: string) => {
    let restored = restoring.current.get(chatId);
    if (!restored) {
      // The newest message the chat sent, as the read starts (see sameAsSent).
      const lastSent =
        state.activeId === chatId
          ? [...state.messages].reverse().find((m) => m.role === "user")?.attachments
          : undefined;
      restored = pendingStore.read(chatId).then(({ files, problem }) => {
        if (problem === "unsupported") return;
        if (problem) return notePendingIssue(chatId, problem);
        saving.current.add(chatId);
        if (!files.length || pendingFiles.current.has(chatId)) return;
        pendingFiles.current.set(chatId, files);
        if (activeRef.current === chatId) setAttachments(files);
        if (sameAsSent(files, lastSent)) notePendingIssue(chatId, "maybe_sent");
      });
      restoring.current.set(chatId, restored);
    }
    return restored;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: restorePending reads a chat once per launch; only a newly active chat starts a read.
  useEffect(() => {
    setAttachments((state.activeId && pendingFiles.current.get(state.activeId)) || []);
    if (state.activeId) void restorePending(state.activeId);
  }, [state.activeId]);
  const saveFiles = async (chatId: string, files: ChatAttachment[]) => {
    const problem: PendingChatProblem | undefined = await pendingStore.write(chatId, files);
    if (problem === "not_overwritten") {
      saving.current.delete(chatId);
      notePendingIssue(chatId, "unreadable");
    } else if (problem !== "unsupported") notePendingIssue(chatId, problem ? "not_saved" : null);
  };
  /** Settles once the change is saved, when this chat saves at all (R102: a card waits for it). */
  const keepFiles = (chatId: string, next: ChatAttachment[]) => {
    if (next.length) pendingFiles.current.set(chatId, next);
    else pendingFiles.current.delete(chatId);
    if (activeRef.current === chatId) setAttachments(next);
    return saving.current.has(chatId) ? saveFiles(chatId, next) : undefined;
  };
  /** Sets aside a saved record the chat could not read, keeping it, so the chat saves again. */
  const resetPendingRecord = async () => {
    const chatId = state.activeId;
    if (!chatId || resettingPending) return;
    setResettingPending(true);
    setError(null);
    const problem = await pendingStore.setAside(chatId);
    setResettingPending(false);
    if (problem) return setError("附件记录未能重置，原记录保留。请稍后重试。");
    saving.current.add(chatId);
    notePendingIssue(chatId, null);
    const files = pendingFiles.current.get(chatId);
    if (files?.length) void saveFiles(chatId, files);
  };
  // The / menu and the 快捷操作 menu share the composer's actions (R80); a prompt action
  // chosen from / opens in the 快捷操作 menu to be filled and previewed there.
  const [promptRequest, setPromptRequest] = useState<{
    pluginId: string;
    actionId: string;
    title: string;
    nonce: number;
  } | null>(null);
  // `/feedback` (R125): each run opens the panel with what the chat shows then.
  const [feedbackRequest, setFeedbackRequest] =
    useState<FeedbackRequest | null>(null);
  const fileSerial = useRef(0);
  /** Read picked files one by one into the active chat's pending attachments. Each file
   *  stands alone: a rejected one keeps the others and stays as a failed card (R70, R78).
   *  A retry reads a card's own file again, under that same card (R102). */
  const importFiles = async (files: File[], retried?: FileCard) => {
    const chatId = state.activeId,
      generation = importGeneration.current,
      parse = bridge.parseChatFile;
    if (!files.length || importing || !chatId) return;
    setError(null);
    if (attachments.length + files.length > 4) {
      setError("每条消息最多附加4个文件。");
      return;
    }
    if (!parse) {
      setError("附件读取服务不可用，请重启应用。");
      return;
    }
    const current = () =>
      activeRef.current === chatId && importGeneration.current === generation;
    // A card's id outlives the run in its record, so no later launch may reuse it.
    const picked = retried?.file
      ? [{ id: retried.id, file: retried.file }]
      : files.map((file) => ({ id: `file-${++fileSerial.current}-${crypto.randomUUID()}`, file }));
    const ids = new Set(picked.map((p) => p.id));
    setImporting(true);
    setReading(picked.map((p) => ({ id: p.id, name: p.file.name })));
    // On record before anything is read: an exit or a switch mid-read leaves a card (R102).
    keepCards(chatId, (list) => [
      ...list.filter((c) => !ids.has(c.id)),
      ...picked.map((p) => ({ id: p.id, name: p.file.name, file: p.file })),
    ]);
    let next = attachments;
    try {
      // Files a restart brings back come first and count toward the four (R101).
      await restorePending(chatId);
      if (!current()) return;
      next = pendingFiles.current.get(chatId) ?? [];
      if (next.length + files.length > 4) {
        // Never read: a new pick leaves no card, and a retried one is as it was.
        keepCards(chatId, (list) =>
          retried ? list.map((c) => (c.id === retried.id ? retried : c)) : list.filter((c) => !ids.has(c.id)),
        );
        throw new Error("每条消息最多附加4个文件。");
      }
      for (const { id, file } of picked) {
        if (!current()) return;
        if (cancelledFiles.current.has(id)) continue;
        let joined: ChatAttachment[] | null = null;
        let failure = "附件未能读取。";
        try {
          const picture = /\.(png|jpe?g)$/i.test(file.name);
          if (file.size > (picture ? 8 : 4) * 1024 * 1024)
            throw new Error(picture ? "图片不能超过8 MB。" : "单个附件不能超过4 MB。");
          const bytes = new Uint8Array(await file.arrayBuffer());
          // Cancelled, or the chat changed, while the window read it: the main process is
          // never asked (R118), and the checks below drop the card's turn.
          if (!current() || cancelledFiles.current.has(id)) throw new Error();
          parsingFile.current = id;
          const result = await parse(file.name, bytes, id).finally(() => {
            if (parsingFile.current === id) parsingFile.current = null;
          });
          if (!result.ok) throw new Error(result.message);
          // Over the message's limits with the files before it: refused on its own (R102).
          joined = validateChatAttachments([...next, result.attachment]);
        } catch (e) {
          if (e instanceof Error && e.message) failure = e.message;
        }
        // Cancelled while it was read, or the chat changed: the late result goes nowhere.
        if (!current()) return;
        if (cancelledFiles.current.has(id)) continue;
        setReading((r) => r.filter((x) => x.id !== id));
        if (joined) {
          next = joined;
          const saved = keepFiles(chatId, next);
          // Out of the tray now, off the record once the file itself is saved: an exit
          // in between leaves a card rather than nothing (R102).
          if (saved) {
            keepCards(chatId, (list) => list.map((c) => (c.id === id ? { ...c, settling: true } : c)));
            void saved.then(() => keepCards(chatId, (list) => list.filter((c) => c.id !== id)));
          } else keepCards(chatId, (list) => list.filter((c) => c.id !== id));
        } else keepCards(chatId, (list) => list.map((c) => (c.id === id ? { ...c, error: failure } : c)));
      }
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : "附件未能读取。");
    } finally {
      if (current()) {
        setImporting(false);
        setReading([]);
      }
    }
  };
  const cancelFile = (key: string) => {
    const id = key.slice(2);
    cancelledFiles.current.add(id);
    if (parsingFile.current === id) stopParsing();
    setReading((r) => r.filter((x) => x.id !== id));
    if (state.activeId) keepCards(state.activeId, (list) => list.filter((c) => c.id !== id));
  };
  const retryFile = (key: string) => {
    const card = cards.find((c) => c.id === key.slice(2));
    if (!card?.file || importing) return;
    void importFiles([card.file], card);
  };
  // R82: a pasted screenshot and files dropped on the composer go through importFiles like the
  // picker — bytes only, never a local path — so the same limits and failure cards apply.
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const canImport = () => !busy && Boolean(active) && !importing && !managing;
  const refuseImport = () =>
    setError(busy ? "黑塔正在回复，结束后再添加附件。" : importing ? "附件还在读取，请稍候。" : "当前无法添加附件。");
  const onComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    slash.onPaste();
    const files = Array.from(event.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return; // ordinary text paste: leave it alone
    event.preventDefault();
    if (!canImport()) return refuseImport();
    void importFiles(
      files.map((f) => {
        if (f.name && f.name !== "image.png") return f;
        const sub = f.type.split("/")[1] ?? "png";
        return new File([f], `pasted-image.${sub === "jpeg" ? "jpg" : sub.replace(/[^a-z0-9]/gi, "")}`, { type: f.type });
      }),
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
      if (!canImport()) return refuseImport();
      const files = Array.from(event.dataTransfer.files);
      if (!files.length) return;
      void importFiles(files);
      composer.current?.focus({ preventScroll: true });
    },
  };
  const removePending = (key: string) => {
    const chatId = state.activeId;
    if (!chatId) return;
    if (key.startsWith("f:"))
      keepCards(chatId, (list) => list.filter((c) => c.id !== key.slice(2)));
    else {
      const index = Number(key.split(":")[1]);
      keepFiles(chatId, attachments.filter((_, n) => n !== index));
    }
  };
  // A card being read shows as such; every other one is a file not added, which blocks sending.
  const readingIds = new Set(reading.map((r) => r.id));
  const failedCards = cards.filter((c) => !c.settling && !readingIds.has(c.id));
  const pendingItems: TrayItem[] = [
    ...attachments.flatMap((a, i): TrayItem[] =>
      a.image ? [{ key: `a:${i}:${a.name}`, name: a.name, picture: { src: imageDataURL(a.image) } }] : [],
    ),
    ...attachments.flatMap((a, i): TrayItem[] =>
      a.image
        ? []
        : [{ key: `a:${i}:${a.name}`, name: a.name, meta: chatFileMeta(a), preview: <ChatFileText attachment={a} pending /> }],
    ),
    ...reading.map((r): TrayItem => ({ key: `r:${r.id}`, name: r.name, state: "reading" })),
    ...failedCards.map((c): TrayItem => ({
      key: `f:${c.id}`,
      name: c.name,
      state: "failed",
      error: cardError(c),
      ...(c.file ? {} : { retry: false as const }),
    })),
  ];
  const [budget, setBudget] = useState<number>(defaultChatOutputBudget);
  const [models, setModels] = useState<
    {
      key: string;
      providerId: string;
      providerName: string;
      providerRevision: number;
      modelId: string;
      label: string;
      efforts: readonly string[];
      search: boolean;
      images: boolean;
    }[]
  >([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [selected, setSelected] = useState("");
  const [effort, setEffort] = useState("");
  const efforts = models.find((m) => m.key === selected)?.efforts ?? [];
  // The same words as the workbench's picker; the select is already labelled 思考 (R72).
  const effortLabels: Record<string, string> = {
    none: "关闭",
    enabled: "开启",
    low: "轻度",
    medium: "标准",
    high: "深度",
    max: "最高",
  };
  useEffect(() => {
    const saved = state.activeId
      ? localStorage.getItem(
          `the-herta.chat-effort.${state.activeId}.${selected}`,
        )
      : null;
    setEffort(saved && efforts.includes(saved) ? saved : "");
  }, [state.activeId, selected, models]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false),
    [managing, setManaging] = useState(false);
  const [listCollapsed, setListCollapsed] = useResponsiveSidebar(
    "the-herta.chat-list-collapsed.v1",
  );
  const panel = useRef<HTMLElement>(null);
  const [contextSaving, setContextSaving] = useState(false);
  const latest = useRef<HTMLButtonElement>(null);
  const busy = state.busy || sending || managing || contextSaving;
  const active = state.chats.find((c) => c.id === state.activeId);
  const receive = (value: HertaChatSnapshot) =>
    setState((old) => (value.revision >= old.revision ? value : old));
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!bridge.getHertaChat) throw new Error();
        const value = await bridge.getHertaChat();
        if (alive) receive(value);
      } catch {
        if (alive) setError("聊天记录暂不可用，请重新打开入口。");
      }
      if (alive) timer = setTimeout(poll, 400);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [bridge]);
  useEffect(() => {
    if (!visible || settingsOpen) return;
    let alive = true;
    void bridge
      .getProviderSettings()
      .then((view) => {
        if (!alive) return;
        const options = view.settings.providers.flatMap((p) =>
          p.models
            .filter(
              (m) =>
                ["text-available", "tools-available"].includes(
                  m.validation.state,
                ) &&
                m.validation.providerRevision === p.revision &&
                m.validation.protocol === p.protocol,
            )
            .map((m) => ({
              key: JSON.stringify([p.id, m.id]),
              providerId: p.id,
              providerName: p.name,
              providerRevision: p.revision,
              modelId: m.id,
              // Model first: a narrow selector truncates the provider, not the model (R44).
              label: `${m.id} · ${p.name}`,
              efforts: reasoningChoices(p, m.id),
              search: webSearchSupport(p, m.id),
              images: imageSupport(p, m.id),
            })),
        );
        setModels(options);
        const preferred = view.settings.defaultBindings?.persona;
        setDefaultModel(
          options.find(
            (m) =>
              m.providerId === preferred?.providerId &&
              m.modelId === preferred?.modelId,
          )?.key ??
            options[0]?.key ??
            "",
        );
      })
      .catch(() => {
        if (alive) setError("无法读取模型配置。");
      });
    return () => {
      alive = false;
    };
  }, [bridge, visible, settingsOpen]);
  useEffect(() => {
    activeRef.current = state.activeId;
    if (!state.activeId) {
      setDraft("");
      return;
    }
    const savedBudget = Number(
      localStorage.getItem(`the-herta.chat-budget.${state.activeId}`),
    );
    setBudget(
      (chatOutputBudgets as readonly number[]).includes(savedBudget)
        ? savedBudget
        : defaultChatOutputBudget,
    );
    const key = draftKey(state.activeId);
    // Migrate the v1 global draft exactly once, only when the target has no draft.
    const legacy = localStorage.getItem("the-herta.chat-draft.v1");
    if (legacy !== null) {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, legacy);
      localStorage.removeItem("the-herta.chat-draft.v1");
    }
    setDraft(localStorage.getItem(key) ?? "");
  }, [state.activeId]);
  useEffect(() => {
    const saved = state.activeId
      ? localStorage.getItem(modelKey(state.activeId))
      : null;
    const legacy = localStorage.getItem("the-herta.chat-model.v1");
    setSelected(
      models.find((m) => m.key === (saved ?? legacy))?.key ?? defaultModel,
    );
  }, [state.activeId, models, defaultModel]);
  useEffect(() => {
    if (visible) tail.stick();
  }, [state.messages, visible]);
  const changeDraft = (value: string) => {
    setDraft(value);
    if (state.activeId) localStorage.setItem(draftKey(state.activeId), value);
  };
  const manage = async (action: HertaChatAction) => {
    if (busy || !bridge.manageHertaChat) return false;
    // A blank current chat (no messages, draft or files) is already a new
    // chat: focus it instead of stacking identical empty ones (R68).
    if (
      action.type === "create" &&
      active &&
      !active.archived &&
      active.messageCount === 0 &&
      state.messages.length === 0 &&
      !draft.trim() &&
      attachments.length === 0
    ) {
      composer.current?.focus({ preventScroll: true });
      return true;
    }
    if (action.type !== "storage") {
      setManaging(true);
      setError(null);
    }
    try {
      receive(await bridge.manageHertaChat(action));
      return true;
    } catch (e) {
      if (action.type !== "storage") setError(safeError(e));
      return false;
    } finally {
      if (action.type !== "storage") setManaging(false);
    }
  };
  // The host applies memory edits outside the turn, so a running reply does not
  // block them; failures go back to the dialog or proposal that made them (R62).
  const editMemory = async (
    action: Extract<HertaChatAction, { type: "memory" }>,
  ): Promise<string | null> => {
    if (!bridge.manageHertaChat) return memoryError(null);
    try {
      receive(await bridge.manageHertaChat(action));
      return null;
    } catch (e) {
      return memoryError(e);
    }
  };
  // F04 (R117): one picture change at a time. The switches stay enabled while it waits (Chromium
  // moves focus off a button that becomes disabled, R116); a click meanwhile is ignored.
  const pictureChanging = useRef(false);
  const [pictureUse, setPictureUse] = useState<{
    chatId: string;
    messageId: string;
    note?: string;
  } | null>(null);
  const changePictureUse = (
    messageId: string,
    indexes: number[],
    use: "stop" | "send",
  ) => {
    const chatId = state.activeId;
    if (
      !chatId ||
      busy ||
      pictureChanging.current ||
      !bridge.manageHertaChat ||
      !indexes.length
    )
      return;
    pictureChanging.current = true;
    setPictureUse({ chatId, messageId });
    const settle = (note?: string) => {
      pictureChanging.current = false;
      setPictureUse(
        note && activeRef.current === chatId
          ? { chatId, messageId, note }
          : null,
      );
    };
    bridge
      .manageHertaChat({
        type: "picture-use",
        id: chatId,
        messageId,
        indexes,
        use,
      })
      .then(
        (value) => {
          receive(value);
          settle();
        },
        (e) => settle(pictureUseError(e)),
      );
  };
  // Errors stay inside the storage dialog instead of the chat banner behind it.
  const cleanup = async (action: HertaChatAction): Promise<string | null> => {
    if (busy || !bridge.manageHertaChat) return "请等待回复结束或先停止，再管理聊天。";
    try {
      receive(await bridge.manageHertaChat(action));
      return null;
    } catch (e) {
      return cleanupError(e);
    }
  };
  const send = async () => {
    const model = models.find((m) => m.key === selected),
      chatId = state.activeId;
    // A file that could not be added is never skipped quietly: it is retried or removed first,
    // a card a restart brought back included (R102).
    if (failedCards.length && !busy) {
      setError("还有附件没有添加成功：请重试或移除它，再发送。");
      return;
    }
    if (importing || !draft.trim() || !model || busy || !bridge.sendHertaChat || !chatId)
      return;
    const submitted = draft;
    setSending(true);
    setError(null);
    try {
      // Files a restart brings back are seen before they go anywhere (R101).
      await restorePending(chatId);
      const pending = pendingFiles.current.get(chatId) ?? [];
      if (pending.length !== attachments.length || pending.some((file, i) => file !== attachments[i]))
        return setError(RESTORED_UNSEEN);
      const result = await bridge.sendHertaChat({
        ...(webSearch && model.search ? { webSearch: true } : {}),
        chatId,
        text: submitted,
        ...(attachments.length ? { attachments } : {}),
        providerId: model.providerId,
        modelId: model.modelId,
        maxOutputTokens: budget,
        ...(effort && efforts.includes(effort)
          ? { reasoningEffort: effort }
          : {}),
      });
      if (result.accepted) {
        keepFiles(chatId, []);
        if (localStorage.getItem(draftKey(chatId)) === submitted)
          localStorage.setItem(draftKey(chatId), "");
        if (activeRef.current === chatId)
          setDraft((value) => (value === submitted ? "" : value));
        tail.jump();
        if (bridge.getHertaChat) receive(await bridge.getHertaChat());
      }
    } catch (e) {
      setError(safeError(e));
    } finally {
      setSending(false);
    }
  };
  const lastFailure = state.messages.at(-1)?.failure;
  const footerError =
    error ||
    (lastFailure && state.error === chatFailures[lastFailure]
      ? null
      : state.error);
  const pendingIssue = state.activeId ? pendingIssues[state.activeId] : undefined;
  const cardProblem = state.activeId ? cardProblems[state.activeId] : undefined;
  // Workbench ⇄ chat swaps fade the surface in; replies appended while the
  // reader is here rise in (R46). A switched-to chat lands on its newest line
  // before paint, and the messages in view then come in one by one (R71).
  useEntrance(panel, "panel", visible, visible);
  useAppendEntrance(
    scroller,
    state.messages.map((m) => m.id),
    state.activeId,
    "message",
    visible,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new chat resets the reader's scroll-follow choice.
  useLayoutEffect(() => {
    tail.jump();
  }, [state.activeId]);
  useSwitchEntrance(scroller, state.activeId, "[data-entrance]", 0, visible);
  // 回到最新 rises like the other small popovers when the reader scrolls away (R54).
  useEntrance(latest, "popover-up", Boolean(tail.away && active), visible);
  const toggleList = () => setListCollapsed((value) => !value);
  const contextCount = state.messages.length - state.contextStart;
  // The / menu and the 快捷操作 menu share what stops a command (R123).
  const composerState = {
    noTarget: !active,
    replying: busy,
    reading: importing,
    empty: state.messages.length === 0,
  };
  // `/feedback` (R125): what the chat shows now — its error, its last failure by code and
  // the choices that shape a reply — for the user to pick from; never its messages.
  const feedbackContext = (): FeedbackContext => {
    const failed = [...state.messages].reverse().find((m) => m.failure);
    const model = models.find((m) => m.key === selected);
    const total = state.messages.length;
    return {
      scope: "chat",
      error: footerError || (lastFailure ? chatFailures[lastFailure] : null),
      failure: failed?.failure
        ? [
            { label: "代码", value: failed.failure },
            { label: "时间", value: formatStamp(failed.at) },
          ]
        : null,
      settings: [
        { label: "模型", value: model?.label ?? "未选择" },
        ...(effort
          ? [{ label: "思考", value: effortLabels[effort] ?? effort }]
          : []),
        { label: "回复额度", value: String(budget) },
        {
          label: "联网搜索",
          value: !model?.search
            ? "所选模型不支持"
            : webSearch
              ? "开启"
              : "关闭",
        },
        {
          label: "续聊范围",
          value:
            state.contextStart <= 0
              ? "全部历史"
              : state.contextStart >= total
                ? "仅从下一条消息开始"
                : `最近 ${total - state.contextStart} 条（共 ${total} 条）`,
        },
        {
          label: "续聊要点",
          value: state.contextNote.trim() ? "已填写（内容不包含）" : "无",
        },
      ],
    };
  };
  // `/export` (R124): the open chat's messages, as the window shows them.
  const saveExport = bridge.saveSessionExport;
  const goal = useGoalController(
    "chat",
    state.activeId,
    busy,
    visible && !settingsOpen,
  );
  const contextModel = models.find(m => m.key === selected);
  const context = useChatContext(
    state,
    contextModel ? { providerId: contextModel.providerId, modelId: contextModel.modelId, providerRevision: contextModel.providerRevision, ...(effort ? { reasoningEffort: effort } : {}) } : null,
    busy,
    visible && !settingsOpen,
    receive,
    setContextSaving,
  );
  const backend = useBackendCommands(
    state.activeId ?? "new-chat",
    [
      ...(saveExport
      ? [
          exportCommand("chat", async () => {
            const title = active?.title ?? "新聊天";
            const markdown = buildChatMarkdown(
              {
                title,
                messages: state.messages,
                contextStart: state.contextStart,
                contextNote: state.contextNote,
              },
              { now: new Date() },
            );
            const r = await saveExport(title, markdown);
            return r.saved
              ? "saved"
              : r.failed === true
                ? "failed"
                : "cancelled";
          }),
          feedbackCommand(() => {
            const context = feedbackContext();
            setFeedbackRequest((r) => ({
              nonce: (r?.nonce ?? 0) + 1,
              context,
            }));
          }),
        ]
      : []),
      ...(goal.available ? [goalCommand(goal.open)] : []),
      ...(context.available ? [compactCommand("chat", context.open)] : []),
    ],
  );
  const slash = useSlashMenu({
    scope: "chat",
    target: state.activeId ?? "new-chat",
    textarea: composer,
    draft,
    setDraft: changeDraft,
    disabled: !visible || settingsOpen || managing || !active,
    state: composerState,
    backend,
    onPromptAction: (pluginId, actionId, title) =>
      setPromptRequest({ pluginId, actionId, title, nonce: Date.now() }),
  });
  return (
    <section
      ref={panel}
      className="herta-chat-panel"
      role="tabpanel"
      id="herta-chat-panel"
      aria-labelledby="herta-chat-tab"
      hidden={!visible}
      onPointerDownCapture={noteActivity}
      onKeyDownCapture={noteActivity}
    >
      <div className={`herta-chat-body${listCollapsed ? " is-collapsed" : ""}`}>
        {!listCollapsed && (
          <ChatSidebar
            visible={visible}
            chats={state.chats}
            activeId={state.activeId}
            busy={busy}
            manage={manage}
          />
        )}
        <section className="herta-chat-conversation" aria-label="当前聊天">
          {/* One toolbar like the workbench's: list toggle, the chat's name,
              its live status, and quiet actions (R46). */}
          <header className="herta-chat-toolbar">
            <button
              type="button"
              className="herta-chat-toggle"
              aria-label={listCollapsed ? "展开聊天列表" : "收起聊天列表"}
              aria-expanded={!listCollapsed}
              onClick={toggleList}
            >
              <Icon name="sidebar" />
            </button>
            <h1 className="herta-chat-title" title={active?.title}>
              {active?.title ?? "选择聊天或新建聊天"}
            </h1>
            {state.busy && (
              <small className="herta-chat-status">
                <WaitingStatus
                  startedAt={state.messages.at(-1)?.at}
                  receiving={Boolean(state.messages.at(-1)?.text)}
                />
              </small>
            )}
            <div className="herta-chat-header-actions">
              <ChatStorage usage={state.storage} cleanup={state.imageCleanup} busy={busy} onRefresh={() => manage({ type: "storage" })} onCleanup={cleanup} />
              <ChatMemory memory={state.memory} onManage={editMemory} />
              <button type="button" onClick={onSettings}>
                连接与模型
              </button>
            </div>
          </header>
          <div className={`herta-chat-messages${tail.away ? " is-away" : ""}`} ref={scroller}>
            {state.messages.length === 0 && (
              <div className="herta-chat-empty">
                <span aria-hidden="true">
                  <Icon name="spark" />
                </span>
                <h2>这次，有什么有趣的事？</h2>
                <p>可以聊研究，也可以只是来坐一会儿。</p>
              </div>
            )}
            {state.messages.map((m, i) => (
              <div key={m.id} data-entrance={m.id}>
                {state.contextStart > 0 && i === state.contextStart && (
                  <p className="herta-chat-context-boundary">
                    黑塔从这里开始参考；更早的内容只保留在记录中
                  </p>
                )}
                <article className={`herta-chat-message is-${m.role}`}>
                  <strong>{m.role === "assistant" ? "黑塔" : "你"}</strong>
                  <MessageTime at={m.at} />
                  {m.attachments?.length ? (
                    <ChatMessageAttachments
                      attachments={m.attachments}
                      chatId={state.activeId!}
                      messageId={m.id}
                      {...(m.role === "user"
                        ? {
                            modelUse: {
                              inContext: i >= state.contextStart,
                              disabled: busy,
                              ...(pictureUse?.chatId === state.activeId &&
                              pictureUse.messageId === m.id &&
                              pictureUse.note
                                ? { note: pictureUse.note }
                                : {}),
                              onChange: (
                                indexes: number[],
                                use: "stop" | "send",
                              ) => changePictureUse(m.id, indexes, use),
                            },
                          }
                        : {})}
                    />
                  ) : null}
                  <SearchResults events={m.searches} running={m.status === 'streaming'} />
                  {m.reasoning && (
                    <details className="herta-chat-reasoning">
                      <summary>
                        {m.status === "streaming" && !m.text
                          ? "正在思考…"
                          : "查看思考"}
                      </summary>
                      <pre>{m.reasoning}</pre>
                      {m.reasoningTruncated && (
                        <small>思考记录较长，仅展示前 32000 字符。</small>
                      )}
                    </details>
                  )}
                  {m.text && (
                    <MessageContent
                      text={m.text}
                      streaming={m.status === "streaming"}
                      onMemory={
                        m.role === "assistant" && m.status === "complete"
                          ? editMemory
                          : undefined
                      }
                      memoryItems={state.memory?.items}
                      downloadable={
                        m.role === "assistant" && m.status === "complete"
                      }
                    />
                  )}
                  {m.failure && (
                    <p className="herta-chat-failure">
                      {chatFailures[m.failure]}
                    </p>
                  )}
                  {m.status !== "complete" && (
                    <small>
                      {m.status === "streaming"
                        ? "正在回复…"
                        : m.status === "cancelled"
                          ? "已停止"
                          : m.status === "interrupted"
                            ? "上次回复已中断"
                            : "回复未完成"}
                    </small>
                  )}
                </article>
              </div>
            ))}
            {/* Sticky at the transcript's foot, so it never shifts the layout (R44). */}
            {tail.away && active && (
              <button type="button" ref={latest} className="herta-latest herta-chat-latest" onClick={tail.jump}>
                回到最新
              </button>
            )}
          </div>
          <footer>
            <GoalStrip goal={goal} />
            {footerError && <p role="alert">{footerError}</p>}
            {backend.notice && (
              <p role={backend.notice.error ? "alert" : "status"}>
                {backend.notice.text}
              </p>
            )}
            {pendingIssue && <p role="alert">{PENDING_ISSUES[pendingIssue]}</p>}
            {pendingIssue === "unreadable" && (
              <p>
                <button
                  type="button"
                  disabled={resettingPending || busy}
                  onClick={() => void resetPendingRecord()}
                >
                  重置附件记录
                </button>
              </p>
            )}
            {cardProblem && <p role="alert">{CARD_PROBLEMS[cardProblem]}</p>}
            {!models.length && (
              <p>
                先在连接设置中验证一个对话模型。
                <button
                  type="button"
                  onClick={() => {
                    onSettings();
                  }}
                >
                  打开设置
                </button>
              </p>
            )}
            {footerError !== IMAGE_UNSUPPORTED && (attachments.some(a => a.image) || state.messages.slice(state.contextStart).some(m => m.attachments?.some(a => (a.image || a.imageDeferred) && a.modelUse !== "stopped"))) && (
              <p className="herta-chat-image-notice">{models.find(m => m.key === selected)?.images ? "图片将随当前续聊内容发送给所选模型。" : IMAGE_UNSUPPORTED}</p>
            )}
            <div
              className={`herta-chat-composer${dragOver ? " is-dragover" : ""}`}
              {...dropHandlers}
            >
              <AttachmentTray
                label="待发送的附件"
                items={pendingItems}
                disabled={busy || importing}
                onRemove={removePending}
                onCancel={cancelFile}
                onRetry={retryFile}
              />
            {slash.menu}
            <textarea
              ref={composer}
              aria-label="给黑塔的消息"
              {...slash.textareaProps}
              onPaste={onComposerPaste}
              onBlur={slash.close}
              placeholder={
                active
                  ? "说点什么… Ctrl+Enter 发送，Enter 换行"
                  : "先新建或恢复一个聊天"
              }
              disabled={!active || managing}
              value={draft}
              maxLength={32000}
              onChange={(e) => {
                changeDraft(e.target.value);
                slash.onChange(e.target.value, e.target.selectionStart);
              }}
              onKeyDown={(e) => {
                if (slash.onKeyDown(e)) return;
                if (
                  e.key === "Enter" &&
                  (e.ctrlKey || e.metaKey) &&
                  !e.nativeEvent.isComposing &&
                  e.nativeEvent.keyCode !== 229
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="herta-chat-controls">
              <PromptActionPicker onOpenOutputs={() => setPluginFilesOwner(state.activeId)} scope="chat" target={state.activeId ?? "new-chat"} draft={draft} draftRevision={draftVersion.current.revision} disabled={!visible || settingsOpen || busy || managing || !active} state={composerState} backend={backend} request={promptRequest} onInsert={(text, expectedRevision?: number) => { if (expectedRevision !== undefined && draftVersion.current.revision !== expectedRevision) return false; changeDraft(text); composer.current?.focus({ preventScroll: true }); return true; }} />
              <label
                className="herta-chat-upload"
                title="附加文件：文本与代码、PDF、DOCX、PNG/JPEG，每条最多 4 个（也可粘贴截图或拖入文件）"
              >
                <span aria-hidden="true">{importing ? "…" : <Icon name="attach" />}</span>
                <input type="file" multiple aria-label="附加文件"
                  disabled={busy || !active || importing}
                  accept=".txt,.md,.csv,.json,.xml,.yaml,.yml,.html,.css,.js,.ts,.tsx,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.sql,.log,.pdf,.docx,.png,.jpg,.jpeg"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    void importFiles(files);
                  }}
                />
              </label>
              <SearchToggle supported={models.find(m => m.key === selected)?.search === true} enabled={webSearch} disabled={busy || !active} onChange={value => { setWebSearch(value); if (state.activeId) localStorage.setItem(`the-herta.chat-search.${state.activeId}`, String(value)); }} />
              <div className="herta-chat-send-group">
              <ChatModelPicker
                target={state.activeId}
                shown={visible && !settingsOpen}
                disabled={busy || !active}
                models={models}
                selected={selected}
                effort={effort}
                budget={budget}
                onModel={(value) => {
                  setSelected(value);
                  if (state.activeId)
                    localStorage.setItem(modelKey(state.activeId), value);
                }}
                onEffort={(value) => {
                  setEffort(value);
                  if (state.activeId)
                    localStorage.setItem(
                      `the-herta.chat-effort.${state.activeId}.${selected}`,
                      value,
                    );
                }}
                onBudget={(value) => {
                  setBudget(value);
                  if (state.activeId)
                    localStorage.setItem(
                      `the-herta.chat-budget.${state.activeId}`,
                      String(value),
                    );
                }}
                onManage={onSettings}
              />
              {state.busy ? (
                <button
                  type="button"
                  className="herta-chat-stop"
                  aria-label="停止"
                  title="停止回复"
                  onClick={() =>
                    void bridge
                      .stopHertaChat?.()
                      .catch(() => setError("停止请求未完成，请稍后再试。"))
                  }
                >
                  <Icon name="stop" />
                </button>
              ) : (
                <button
                  type="button"
                  className="herta-chat-send"
                  aria-label="发送"
                  title="发送 · Ctrl+Enter"
                  disabled={importing || busy || !draft.trim() || !selected || !active}
                  onClick={() => void send()}
                >
                  <Icon name="send" />
                </button>
              )}
              </div>
            </div>
            </div>
            {/* Under the box, like the workbench's metrics row: what the next
                reply will read, and the control that changes it (R46). */}
            <div className="herta-chat-meta">
              {active && (
                <ChatContextPanel context={context} />
              )}
              {active && (
                <span className="herta-chat-meta-item">
                  续聊 {contextCount} 条消息 · 约{" "}
                  {state.contextCharacters.toLocaleString()} 字符
                </span>
              )}
              {importing && <span role="status">正在读取附件…</span>}
            </div>
          </footer>
        </section>
      </div>
      <PluginDeliverablesPanel scope="chat" target={state.activeId ?? ""} open={!!state.activeId && pluginFilesOwner === state.activeId} shown={visible && !settingsOpen} draftRevision={draftVersion.current.revision} getCurrentRevision={() => draftVersion.current.revision} onClose={() => setPluginFilesOwner(null)} />
      <FeedbackPanel request={feedbackRequest} shown={visible} />
      <GoalPanel goal={goal} />
    </section>
  );
}
