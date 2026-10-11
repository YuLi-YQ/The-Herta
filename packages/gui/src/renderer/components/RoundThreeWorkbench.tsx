import { HertaChat } from "./HertaChat.js";
import welcomePortrait from "../assets/great-herta-welcome-v1.png";
import { ComposerModelPicker } from "./ComposerModelPicker.js";
import type {
  RoundFileContent,
  RoundMetrics,
  RoundSummary,
} from "@herta/app-server";
import type { PermissionMode } from "@herta/core";
import {
  type CSSProperties,
  Fragment,
  useCallback,
  useEffect,
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
import { useSessionList } from "../hooks/useSessionList.js";
import type { SessionSnapshot } from "../ipc/bridge-types.js";
import { EvidenceDetail } from "./EvidenceDetail.js";
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
function readDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** All task facts come from the subscribed session store. Demo state stays separate. */
export function RoundThreeWorkbench(): JSX.Element {
  const { bridge, sessionStore, sessionListStore } = useHertaBridge();
  const session = useActiveSession();
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
  const [chatOpen, setChatOpen] = useState(false);
  const [chatVisited, setChatVisited] = useState(false);
  const selectMode = (chat: boolean) => {
    setChatOpen(chat);
    if (chat) setChatVisited(true);
  };
  const [appVersion, setAppVersion] = useState("");
  const [rounds, setRounds] = useState<RoundSummary[]>([]);
  const [metrics, setMetrics] = useState<RoundMetrics | null>(null);
  const [roundsError, setRoundsError] = useState(false);
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
    setRounds([]);
    setMetrics(null);
    setRoundsError(false);
    setReaderOpen(false);
    setReaderContent(null);
    readerSequence.current += 1;
    const refresh = async () => {
      if (reading || !session.sessionId || !bridge.getRoundSummaries) return;
      reading = true;
      try {
        const [next, usage] = await Promise.all([
          bridge.getRoundSummaries(session.sessionId),
          bridge.getTaskMetrics?.(session.sessionId),
        ]);
        if (!disposed) {
          setRounds(next);
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
    readerTrigger.current?.focus();
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
      if (event.key === "Escape") {
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
  const [collapsed, setCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    Math.max(
      200,
      Math.min(300, Number(readDraft("the-herta.sidebar.v1")) || 240),
    ),
  );
  const [workspace, setWorkspace] = useState("");
  const [draft, setDraft] = useState(() => readDraft("the-herta.draft.v1"));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
  const followOutput = useRef(true);
  const [readingEarlier, setReadingEarlier] = useState(false);
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
  activeId.current = session.sessionId;
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
    if (!permission?.sessionId || !bridge.setWorkbenchPermission) return;
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
      setNotice(
        "权限选择已保存，后续工具派发按新档位处理。已执行操作不会撤回，待审批操作不会自动重放。",
      );
    } catch {
      setError("权限选择未保存，可能因任务切换或设置已更新。请重新选择。");
      await refreshWorkbench();
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new session resets the user's scroll-follow choice.
  useEffect(() => {
    followOutput.current = true;
    setReadingEarlier(false);
  }, [session.sessionId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: append/stream changes trigger DOM measurement without replacing the user's selection or focus.
  useEffect(() => {
    if (followOutput.current && content.current) {
      content.current.scrollTop = content.current.scrollHeight;
    }
  }, [session.record.length, session.streamingText, session.sessionId]);
  const busy = submitting || session.status !== "idle" || session.backendActive;
  const visibleFailure =
    failure ??
    (session.turnFailed
      ? safeProviderFailure({
          code: session.turnFailedProviderCode,
          status: session.turnFailedStatus,
        })
      : null);
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
  useEffect(() => bridge.onOpenSettings?.(() => setSettings(true)), [bridge]);
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
          "新项目已选定；点击新建任务后才会使用此目录。当前会话工作目录未更改。",
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
          `历史无法读取（${result.openError.code}${result.openError.line ? `，第 ${result.openError.line} 行` : ""}）。原任务未切换；不会自动重放操作。`,
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
      const checked = await bridge.getProviderReadiness?.(id);
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
      const result = await bridge.submitText(text);
      if ("failure" in result) {
        if (activeId.current === id) setFailure(result.failure);
        return;
      }
      if ("needsKey" in result) {
        if (activeId.current === id)
          setError(
            "尚未配置可用的 Provider 与角色绑定。文本保留，请在设置中配置并验证模型。",
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
          "请求失败。文本保留；请检查 Provider 配置或网络。不会自动重发或重放工具。",
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
          "已发送取消请求。活动工具与子进程结束状态以任务记录为准；已有磁盘改动不会自动撤销。",
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
        setError("恢复请求失败。已保存结果保留，不会自动重放已有操作。");
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
        setSettings(true);
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
      session.overlay
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
          ✦
        </span>
        <strong>The Herta</strong>
        <nav className="herta-mode-tabs" role="tablist" aria-label="工作模式">
          {[false, true].map((chat) => (
            <button
              key={String(chat)}
              type="button"
              role="tab"
              id={chat ? "herta-chat-tab" : "herta-workbench-tab"}
              aria-selected={chatOpen === chat}
              aria-controls={
                chat ? "herta-chat-panel" : "herta-workbench-panel"
              }
              tabIndex={chatOpen === chat ? 0 : -1}
              onClick={() => selectMode(chat)}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? false
                    : event.key === "End"
                      ? true
                      : !chat;
                selectMode(next);
                document
                  .getElementById(
                    next ? "herta-chat-tab" : "herta-workbench-tab",
                  )
                  ?.focus();
              }}
            >
              {chat ? "与黑塔聊天" : "工作台"}
            </button>
          ))}
        </nav>
        {appVersion && <small className="herta-version">v{appVersion}</small>}
      </header>
      <aside className="herta-sidebar" aria-label="项目与任务导航">
        <button
          type="button"
          disabled={Boolean(session.overlay) || operation}
          onClick={() => void create()}
        >
          ＋ 新建任务
        </button>
        <button type="button" onClick={() => void openProject()}>
          打开项目文件夹
        </button>
        {navigation ? (
          <ProjectSidebar
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
                  onClick={() => void navigator.clipboard.writeText(workspace)}
                >
                  复制项目路径
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
                      ···
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
          onClick={() => setSettings(true)}
        >
          设置 · 连接与模型
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
            ☰
          </button>
          <span className="herta-task-title" title={session.title ?? undefined}>
            {demo
              ? "界面演示"
              : session.title ||
                sessions.find((item) => item.sessionId === session.sessionId)
                  ?.title ||
                sessions
                  .find((item) => item.sessionId === session.sessionId)
                  ?.lastUserText?.slice(0, 45) ||
                (session.sessionId ? "未命名任务" : "新任务")}
          </span>
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
              切换会中断当前请求和工具。已有记录、文件改动与草稿保留，不会自动重放。等待审批时不能切换。
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
        <div
          className="herta-content"
          ref={content}
          onScroll={() => {
            const element = content.current;
            if (!element) return;
            followOutput.current =
              element.scrollHeight - element.clientHeight - element.scrollTop <
              48;
            setReadingEarlier(!followOutput.current);
          }}
        >
          {demo ? (
            <DemoPanel key={demo} view={demo} />
          ) : !session.sessionId ? (
            <section className="herta-welcome herta-welcome-illustrated">
              <div className="herta-welcome-copy">
                <span className="herta-star" aria-hidden="true">
                  ✦
                </span>
                <p className="herta-eyebrow">THE HERTA / WORKBENCH</p>
                <h1>把难题拿来，别让我无聊。</h1>
                <p>
                  选好项目，我们就开始。还没准备目录？也可以先在独立工作区试试。
                </p>
                <div className="herta-actions">
                  <button type="button" onClick={() => void openProject()}>
                    打开项目文件夹
                  </button>
                  <button type="button" onClick={() => setSettings(true)}>
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
                .map((group) => (
                  <Fragment key={group.id}>
                    {session.record
                      .slice(
                        group.start - session.recordStart,
                        group.end - session.recordStart,
                      )
                      .map((block, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: absolute append-only record offsets.
                        <Fragment key={group.start + index}>
                          {!(
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
                            >
                              <strong>
                                {block.kind === "user"
                                  ? "你"
                                  : block.kind === "herta"
                                    ? "The Herta"
                                    : block.label}
                              </strong>
                              <MessageTime at={block.at} />
                              <MessageContent
                                text={
                                  block.kind === "system"
                                    ? block.body
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
                      ))}
                    {group.round && (
                      <RoundResults
                        round={group.round}
                        onRead={(roundId, fileId, line) =>
                          void openRoundFile(roundId, fileId, line)
                        }
                        loadFile={loadRoundFile}
                      />
                    )}
                  </Fragment>
                ))}
              {roundsError && (
                <p className="herta-rounds-error" role="status">
                  本轮结果暂时无法读取，已有对话保留。
                </p>
              )}
              {session.streamingText !== null && (
                <article>
                  <strong>The Herta · 正在输出</strong>
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
                    上次运行已中断。恢复会重新请求模型，并沿用已保存的工具结果，不自动重放已完成操作。
                  </p>
                  {bridge.continueInterrupted && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void resume()}
                    >
                      明确恢复中断任务
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
                  <p>
                    diff 为当前磁盘相对 HEAD
                    的审阅，不是写入前审批；此处不提供应用或撤销。
                  </p>
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
          {(failure || error || session.error || session.turnFailed) && (
            <section role="alert" className="herta-error-card">
              <p>
                {visibleFailure?.message ||
                  error ||
                  (session.error
                    ? "本地任务服务无法加载，请检查配置。原数据保留。"
                    : session.turnFailedStatus === 401 ||
                        session.turnFailedStatus === 403
                      ? "服务拒绝鉴权或访问权限，请检查该连接的 Key 和账户授权。"
                      : session.turnFailedStatus === 429
                        ? "服务限流，请稍后主动重试。"
                        : "本轮请求未完成。已保存结果保留，不会自动重放工具。")}
              </p>
              <button type="button" onClick={() => setSettings(true)}>
                完成配置 / 验证模型
              </button>
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
                  草稿保留；确认连接后可主动点击发送重试。不会自动重放工具。
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
                disabled={busy || operation || Boolean(session.overlay)}
                onClick={() => void switchToProjectLocation()}
              >
                使用项目新位置
              </button>
            </section>
          )}
          {notice && <p role="status">{notice}</p>}
        </div>
        {readingEarlier && (
          <button
            type="button"
            className="herta-latest"
            onClick={() => {
              followOutput.current = true;
              setReadingEarlier(false);
              if (content.current)
                content.current.scrollTop = content.current.scrollHeight;
            }}
          >
            回到最新
          </button>
        )}
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
            <h2>写入或执行前审批</h2>
            <div className="herta-approval-body">
              <p>
                任务：{session.sessionId}
                <br />
                请求：{overlay.requestId}
                <br />
                工作目录：{session.backendWorkspace}
              </p>
              <pre>
                {overlay.command ||
                  (overlay.kind === "pending-permission"
                    ? overlay.summary
                    : "")}
              </pre>
              {overlay.kind === "pending-permission" && (
                <>
                  <p>
                    工具：{overlay.tool} · 风险：{overlay.risk}
                    <br />
                    {overlay.summary}
                  </p>
                  {overlay.files && (
                    <p className="herta-path">
                      目标文件：{overlay.files.join("、")}
                    </p>
                  )}
                  {overlay.diff && (
                    <details>
                      <summary>待写入 diff（尚未执行）</summary>
                      <pre>{overlay.diff}</pre>
                    </details>
                  )}
                </>
              )}
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
          <label className="herta-draft-label" htmlFor="herta-draft">
            任务草稿 · 保存在本机
          </label>
          <div className="herta-composer-box">
            <textarea
              id="herta-draft"
              ref={input}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="描述希望处理的问题… Ctrl+Enter 发送，Enter 换行"
              onKeyDown={(event) => {
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
              <button
                type="button"
                className="herta-attach"
                aria-label="添加文件"
                title="添加文件到当前任务"
                disabled={
                  !session.sessionId ||
                  busy ||
                  operation ||
                  Boolean(pendingInput)
                }
                onClick={async () => {
                  const id = session.sessionId;
                  if (!id) return;
                  const paths = await bridge.pickAttachments();
                  if (!paths?.length || activeId.current !== id) return;
                  setOperation(true);
                  try {
                    const result = await bridge.attachFiles(id, paths);
                    if (activeId.current === id) {
                      if (!result.ok)
                        setError(result.message ?? "文件未添加。");
                      else setNotice("文件已添加到当前任务。");
                    }
                  } catch {
                    if (activeId.current === id)
                      setError("文件未添加，请检查文件是否可读。");
                  } finally {
                    setOperation(false);
                  }
                }}
              >
                ＋
              </button>
              <ComposerModelPicker
                readiness={readiness}
                sessionId={session.sessionId}
                busy={busy}
                refresh={refreshWorkbench}
                manage={() => setSettings(true)}
              />
              {permission && (
                <>
                  <label className="herta-permission-control">
                    <select
                      className="herta-permission-select"
                      aria-label="权限档位"
                      disabled={!permission.sessionId}
                      value={permission.mode}
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
                  <details className="herta-composer-options">
                    <summary title="权限应用范围">···</summary>
                    <label>
                      权限继承
                      <select
                        aria-label="权限应用范围"
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
                  ■
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
                  ↑
                </button>
              )}
            </div>
          </div>
          <RoundDashboard rounds={rounds} metrics={metrics} />
          {fullAccessChoice && (
            <section
              className="herta-permission-confirm"
              aria-label="完全访问确认"
            >
              <p>
                完全访问允许当前系统用户权限下的项目内外文件、命令与网络操作，取消逐项工具审批。不自动提权；不是操作系统沙箱。应用自身的凭据、记录和权限控制仍受保护。升级不会自动执行待审操作。
              </p>
              <button
                type="button"
                onClick={() => void choosePermission("full-access", true)}
              >
                确认完全访问
              </button>
              <button type="button" onClick={() => setFullAccessChoice(false)}>
                取消切换
              </button>
            </section>
          )}
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
          onSettings={() => setSettings(true)}
        />
      )}
      <SettingsModal
        open={settings}
        onClose={() => setSettings(false)}
        {...(session.sessionId ? { sessionId: session.sessionId } : {})}
      />
    </div>
  );
}
