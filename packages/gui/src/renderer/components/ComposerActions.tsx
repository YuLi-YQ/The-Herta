import { useEffect, useRef, useState } from "react";
import type { PluginReply, PromptPlugin } from "../../shared/prompt-plugins.js";
import type { ExportOutcome } from "./Sidebar/session-markdown.js";

/**
 * The composer's commands (R80; one registry since R123, docs/F09_COMMANDS.md): one list
 * behind both the 快捷操作 menu and the `/` menu, so either way reaches the same thing,
 * found by the same search, with the same reason when it cannot run. Each composer action
 * opens a control the composer already has — the file picker, the model choice, the
 * permission level — rather than a second version of it: what the control allows, asks or
 * refuses still applies. The enabled prompt actions join the list as commands that open
 * their form to be filled and previewed; nothing here sends a message. Since R124 the host
 * adds commands it carries out itself (the export), only when it can.
 * The standalone chat has no workspace permission, so it has no permission action.
 */
export interface ComposerAction {
  readonly id: string;
  readonly title: string;
  /** What else `/` matches: an English alias and the pinyin of the title. */
  readonly aliases: readonly string[];
  readonly hint: string;
  readonly group: "添加" | "会话操作";
  /** The existing control, inside the composer. */
  readonly target: string;
  /** What stops it, in order: the first that holds is the reason shown. */
  readonly blockedBy: readonly ComposerBlock[];
}

/** What the host knows about its composer right now; each flag that holds can stop a command. */
export interface ComposerState {
  /** No chat or task is open. */
  readonly noTarget?: boolean;
  /** Herta is replying: a turn is running. */
  readonly replying?: boolean;
  /** A task is being opened or moved to another project location. */
  readonly opening?: boolean;
  /** Files are being read into this draft. */
  readonly reading?: boolean;
  /** The chat or task has no message yet. */
  readonly empty?: boolean;
}
export type ComposerBlock = keyof ComposerState;

/** Prompt actions wait while the 快捷操作 menu cannot open for them. */
const PROMPT_BLOCKED_BY: readonly ComposerBlock[] = ["replying", "opening"];

function blockReason(
  block: ComposerBlock,
  scope: "chat" | "workbench",
): string {
  switch (block) {
    case "noTarget":
      return scope === "chat" ? "先新建或恢复一个聊天" : "先新建或打开一个任务";
    case "replying":
      return "黑塔正在回复，结束后可用";
    case "opening":
      return "正在打开任务，稍候再试";
    case "reading":
      return "正在读取文件，读完后再添加";
    case "empty":
      return scope === "chat" ? "这个聊天还没有消息" : "这个任务还没有消息";
  }
}

/** A control that is missing or disabled for a reason the host did not name. */
const UNAVAILABLE = "当前不可用";

export type Availability =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };
export type CommandOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/** The one wording of a command that did not run, in either menu. */
export function commandError(title: string, reason: string): string {
  return `无法执行“${title}”：${reason}`;
}

export function composerActions(scope: "chat" | "workbench"): ComposerAction[] {
  const actions: ComposerAction[] = [
    {
      id: "attach",
      title: "附加文件",
      aliases: ["attach", "file", "fujian"],
      hint: "选择文件，随这条消息发送",
      group: "添加",
      target:
        scope === "chat"
          ? 'input[type="file"][aria-label="附加文件"]'
          : 'button[aria-label="添加文件"]',
      blockedBy: ["noTarget", "replying", "opening", "reading"],
    },
    {
      id: "model",
      title: "选择模型",
      aliases: ["model", "moxing"],
      hint: scope === "chat" ? "本聊天使用的模型" : "本任务的模型与思考强度",
      group: "会话操作",
      target:
        scope === "chat"
          ? "button.herta-chat-model"
          : ".composer-model-picker .herta-model-status",
      // The workbench's picker stays open to changes during a turn.
      blockedBy: scope === "chat" ? ["noTarget", "replying"] : [],
    },
  ];
  if (scope === "workbench")
    actions.push({
      id: "permission",
      title: "权限档位",
      aliases: ["permission", "quanxian"],
      hint: "工作区权限；完全访问仍需确认",
      group: "会话操作",
      target: 'select[aria-label="权限档位"]',
      blockedBy: ["noTarget"],
    });
  return actions;
}

/** The composer an element sits in: the chat's or the workbench's. */
export function composerRoot(from: Element | null | undefined): Element | null {
  return from?.closest(".herta-chat-composer, .herta-composer-box") ?? null;
}

function control(root: Element | null, action: ComposerAction): HTMLElement | null {
  return root?.querySelector<HTMLElement>(action.target) ?? null;
}

/** Whether the action's control is there and enabled right now (a running turn disables some). */
export function actionAvailable(root: Element | null, action: ComposerAction): boolean {
  const target = control(root, action);
  return target !== null && !(target as HTMLButtonElement).disabled;
}

/** Open the action's control: a click for a button or a file input, the list for a select. */
export function runComposerAction(root: Element | null, action: ComposerAction): boolean {
  const target = control(root, action);
  if (!target || (target as HTMLButtonElement).disabled) return false;
  if (target instanceof HTMLSelectElement) {
    target.focus({ preventScroll: true });
    try {
      target.showPicker?.();
    } catch {
      /* Focused is enough where the list cannot be opened for it. */
    }
    return true;
  }
  target.click();
  return true;
}

/** An enabled prompt action that applies to this composer. */
export interface PromptCommand {
  readonly pluginId: string;
  readonly actionId: string;
  readonly title: string;
  readonly pluginName: string;
}

/** The enabled prompt actions of the listed plugins that apply to this composer. */
export function promptCommands(
  items: readonly PromptPlugin[],
  scope: "chat" | "workbench",
): PromptCommand[] {
  return items
    .filter((p) => p.enabled)
    .flatMap((p) =>
      p.manifest.actions
        .filter((a) => a.scope === "both" || a.scope === scope)
        .map((a) => ({
          pluginId: p.manifest.id,
          actionId: a.id,
          title: a.title,
          pluginName: p.manifest.name,
        })),
    );
}

/** Why the prompt actions could not be listed, worded the same in both menus; null when they were. */
export function promptListProblem(
  reply: PluginReply | undefined,
): string | null {
  if (!reply) return "插件接口不可用。";
  if (!reply.ok) return reply.message;
  return reply.snapshot.damaged ? "插件记录需要在设置中恢复。" : null;
}
/** The list request itself failed. */
export const PROMPT_LIST_FAILED = "无法读取快捷操作，请重新打开。";

/**
 * A command the host carries out itself (R124, docs/F09_COMMANDS.md 3.4). It may take a
 * while — a save dialog — so the registry runs one of each at a time, and its result
 * belongs to the chat or task it ran for: one that comes back after a switch is dropped,
 * never shown on another. A host that lacks the ability passes no such command, so neither
 * menu lists one that cannot work.
 */
export interface BackendCommand {
  readonly id: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly hint: string;
  readonly group: "会话操作";
  readonly blockedBy: readonly ComposerBlock[];
  /** `signal` aborts on a switch: a step that asks the user (a save dialog) must not open for another chat or task. */
  readonly run: (signal: AbortSignal) => Promise<BackendOutcome>;
}
/** How a run ended: done, with a brief notice or none (the user cancelled), or why it failed. */
export type BackendOutcome =
  | { readonly ok: true; readonly notice?: string }
  | { readonly ok: false; readonly reason: string };

/** The reason a command shows while it runs; starting it again is refused with it. */
const RUNNING = "正在执行…";
/** A run that threw instead of saying how it ended. */
const RUN_FAILED = "没有完成，请重试";
/** How long a done notice stays: the sidebar's 已导出 stays as long (Sidebar/SessionItem.tsx). */
const NOTICE_MS = 2400;

/** The host's own commands and what they are doing; both menus get the same one. */
export interface BackendCommands {
  readonly commands: readonly BackendCommand[];
  /** The ids running now. */
  readonly running: readonly string[];
  readonly start: (command: BackendCommand) => CommandOutcome;
  /** The last result for this chat or task: a done notice fades, a failure stays until the next run or a switch. */
  readonly notice: { readonly text: string; readonly error: boolean } | null;
}

/** Run the host's commands for `target`, the chat or task the composer belongs to. */
export function useBackendCommands(
  target: string,
  commands: readonly BackendCommand[],
): BackendCommands {
  const [running, setRunning] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<BackendCommands["notice"]>(null);
  // `live` refuses a second start before the first has re-rendered as running.
  const live = useRef(new Set<string>());
  const runs = useRef(new Set<AbortController>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = (next: BackendCommands["notice"]) => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setNotice(next);
    if (next && !next.error)
      timer.current = setTimeout(() => {
        timer.current = null;
        setNotice(null);
      }, NOTICE_MS);
  };
  // A switch: what still runs belongs to the chat or task before it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the switch itself is the trigger; refs and setters only.
  useEffect(() => {
    for (const run of runs.current) run.abort();
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setNotice(null);
  }, [target]);
  useEffect(() => {
    const all = runs.current;
    return () => {
      for (const run of all) run.abort();
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
  const start = (command: BackendCommand): CommandOutcome => {
    if (live.current.has(command.id))
      return { ok: false, error: commandError(command.title, RUNNING) };
    const run = new AbortController();
    live.current.add(command.id);
    runs.current.add(run);
    setRunning([...live.current]);
    show(null);
    void command
      .run(run.signal)
      .catch((): BackendOutcome => ({ ok: false, reason: RUN_FAILED }))
      .then((outcome) => {
        live.current.delete(command.id);
        runs.current.delete(run);
        setRunning([...live.current]);
        if (run.signal.aborted) return;
        if (!outcome.ok)
          show({
            text: commandError(command.title, outcome.reason),
            error: true,
          });
        else if (outcome.notice) show({ text: outcome.notice, error: false });
      });
    return { ok: true };
  };
  return { commands, running, start, notice };
}

/**
 * `/export` (R124, F09 4.1): the open task's record (the sidebar's export) or the open
 * chat's messages as Markdown, saved where the user picks. Cancelling the dialog is not a
 * failure; a failure changes nothing that was recorded. Main masks secret-shaped text in
 * either before writing it.
 */
export function exportCommand(
  scope: "chat" | "workbench",
  save: (signal: AbortSignal) => Promise<ExportOutcome>,
): BackendCommand {
  return {
    id: "export",
    title: "导出",
    aliases: ["export", "daochu"],
    hint:
      scope === "chat"
        ? "消息存为 Markdown；附件只列名称，不含记忆，疑似密钥会遮蔽"
        : "对话与过程记录存为 Markdown；不含附件内容，疑似密钥会遮蔽",
    group: "会话操作",
    // The chat's reply in progress is part of its messages; the task's record is read as saved.
    blockedBy:
      scope === "chat"
        ? ["noTarget", "replying", "empty"]
        : ["noTarget", "opening", "empty"],
    run: async (signal) => {
      let end: ExportOutcome;
      try {
        end = await save(signal);
      } catch {
        end = "failed";
      }
      if (end === "saved") return { ok: true, notice: "已导出" };
      if (end === "cancelled") return { ok: true };
      return { ok: false, reason: "导出没有完成，原记录未改动" };
    },
  };
}

/**
 * `/feedback` (R125, F09 4.5): opens the feedback panel, where the user describes the
 * problem, picks which diagnostics go in, previews the Markdown and saves it where they
 * choose; nothing is sent anywhere. It needs no chat or task and reads nothing of theirs,
 * so nothing blocks it; the panel says how the save went, inside itself.
 */
export function feedbackCommand(open: () => void): BackendCommand {
  return {
    id: "feedback",
    title: "反馈",
    aliases: ["feedback", "fankui"],
    hint: "整理问题与可选诊断，预览后存为本地 Markdown；不会发送",
    group: "会话操作",
    blockedBy: [],
    run: async () => {
      open();
      return { ok: true };
    },
  };
}

/** The goal panel is readable during a reply; only its mutations wait for idle. */
export function goalCommand(open: () => void): BackendCommand {
  return {
    id: "goal",
    title: "目标",
    aliases: ["goal", "mubiao"],
    hint: "设置或查看当前目标，完成状态由你确认",
    group: "会话操作",
    blockedBy: ["noTarget", "opening"],
    run: async () => {
      open();
      return { ok: true };
    },
  };
}

/** Workbench-only: /plan enters or leaves the backend-enforced read-only mode. */
export function planCommand(toggle: () => Promise<void>): BackendCommand {
  return {
    id: "plan",
    title: "计划模式",
    aliases: ["plan", "jihua"],
    hint: "进入或退出只读计划模式，不会自动执行",
    group: "会话操作",
    blockedBy: ["noTarget", "opening", "replying"],
    run: async () => { await toggle(); return { ok: true }; },
  };
}

/** Scope chooses scheduling on the workbench or the reviewable chat context draft. */
export function compactCommand(scope: "chat" | "workbench", run: () => void | Promise<void>): BackendCommand {
  return {
    id: "compact",
    title: scope === "chat" ? "续聊范围" : "整理先前记录",
    aliases: ["compact", "zhengli"],
    hint: scope === "chat" ? "起草更早消息的要点，检查后应用" : "安排下一回合整理，可随时撤销安排",
    group: "会话操作",
    blockedBy: ["noTarget", "opening", "replying"],
    run: async () => { await run(); return { ok: true }; },
  };
}

/** One entry of either menu: a composer action, a command of the host's or an enabled prompt action. */
export interface ComposerCommand {
  readonly key: string;
  readonly kind: "action" | "backend" | "prompt";
  readonly title: string;
  readonly aliases: readonly string[];
  /** The plugin a prompt action comes from; searched like the title. */
  readonly source?: string;
  readonly hint: string;
  readonly group: string;
  /** Asked when listed and again right before running: a turn may have started in between. */
  readonly availability: () => Availability;
  readonly run: () => CommandOutcome;
}

/**
 * Both menus' list, in one order: the composer's actions, the host's commands, then the
 * prompt actions. `root` finds the composer when asked, so the check before running sees
 * the control as it is then; `openPrompt` opens a prompt action's form in the 快捷操作 menu.
 */
export function composerCommands({
  scope,
  root,
  state,
  prompts,
  openPrompt,
  backend,
}: {
  readonly scope: "chat" | "workbench";
  readonly root: () => Element | null;
  readonly state: ComposerState;
  readonly prompts: readonly PromptCommand[];
  readonly openPrompt: (
    pluginId: string,
    actionId: string,
    title: string,
  ) => void;
  /** The host's own commands (the export), when it has any. */
  readonly backend?: BackendCommands;
}): ComposerCommand[] {
  const blocked = (
    blockedBy: readonly ComposerBlock[],
  ): Availability | null => {
    const block = blockedBy.find((b) => state[b] === true);
    return block ? { ok: false, reason: blockReason(block, scope) } : null;
  };
  const hosted = (host: BackendCommands) =>
    host.commands.map(
      (command): ComposerCommand => ({
        key: `b:${command.id}`,
        kind: "backend",
        title: command.title,
        aliases: command.aliases,
        hint: command.hint,
        group: command.group,
        availability: () =>
          host.running.includes(command.id)
            ? { ok: false, reason: RUNNING }
            : (blocked(command.blockedBy) ?? { ok: true }),
        run: () => host.start(command),
      }),
    );
  return [
    ...composerActions(scope).map(
      (action): ComposerCommand => ({
        key: `a:${action.id}`,
        kind: "action",
        title: action.title,
        aliases: action.aliases,
        hint: action.hint,
        group: action.group,
        availability: () =>
          blocked(action.blockedBy) ??
          (actionAvailable(root(), action)
            ? { ok: true }
            : { ok: false, reason: UNAVAILABLE }),
        run: () =>
          runComposerAction(root(), action)
            ? { ok: true }
            : { ok: false, error: commandError(action.title, UNAVAILABLE) },
      }),
    ),
    ...(backend ? hosted(backend) : []),
    ...prompts.map(
      (p): ComposerCommand => ({
        key: `p:${p.pluginId}/${p.actionId}`,
        kind: "prompt",
        title: p.title,
        aliases: [],
        source: p.pluginName,
        hint: p.pluginName,
        group: "提示词动作",
        availability: () => blocked(PROMPT_BLOCKED_BY) ?? { ok: true },
        run: () => {
          openPrompt(p.pluginId, p.actionId, p.title);
          return { ok: true };
        },
      }),
    ),
  ];
}

/** Run a command the way both menus do: checked again first, so a blocked one says why instead. */
export function runCommand(command: ComposerCommand): CommandOutcome {
  const availability = command.availability();
  if (!availability.ok)
    return {
      ok: false,
      error: commandError(command.title, availability.reason),
    };
  return command.run();
}

/** Whether a query names the command: its title or plugin, or the start of an alias. Both menus search with it. */
export function commandMatches(
  command: {
    readonly title: string;
    readonly aliases: readonly string[];
    readonly source?: string;
  },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  return (
    !q ||
    command.title.toLowerCase().includes(q) ||
    command.aliases.some((a) => a.startsWith(q)) ||
    (command.source?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * The `/` command being typed at the caret, or null. Only a slash that starts a line and
 * is followed by a single word counts: a path (`src/a`, `/usr/bin`), a URL, a slash
 * mid-sentence or one inside a fenced code block never opens the menu.
 */
export function commandAt(value: string, caret: number): string | null {
  const before = value.slice(0, caret);
  const line = before.slice(before.lastIndexOf("\n") + 1);
  if (!/^\/[^\s/\\]*$/u.test(line)) return null;
  let fence: { marker: string; length: number } | null = null;
  for (const previousLine of before.split("\n").slice(0, -1)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(previousLine);
    if (!match) continue;
    const marker = match[1]!;
    const tail = match[2]!;
    if (fence) {
      if (marker[0] === fence.marker && marker.length >= fence.length && tail.trim() === "") fence = null;
    } else if (marker[0] !== "`" || !tail.includes("`")) {
      fence = { marker: marker[0]!, length: marker.length };
    }
  }
  if (fence) return null;
  return line.slice(1);
}
