import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useHertaBridge } from "../context/HertaBridgeContext.js";
import type {
  InteractionLanguageChoice,
  SystemInfo,
  ThemePref,
} from "../ipc/bridge-types.js";
import { type Appearance, appearance } from "../lib/appearance.js";
import { type MotionPreference, motionPreference } from "../lib/motion.js";
import { themePref } from "../lib/theme.js";
import { Icon } from "./Icon.js";
import { formatStamp } from "./Sidebar/session-markdown.js";
import "../styles/feedback.css";

/**
 * `/feedback` (R125, F09 4.5): the user describes the problem, picks which diagnostics
 * go in — none by default — previews the Markdown, edits it if they like, and saves it
 * where they choose with the export's save dialog. Nothing is sent anywhere and no
 * service is called. Never in it unless the user writes it: keys and tokens, the chat's
 * or the task's content, attachments and files. A user name in a path becomes <用户>, in
 * the preview and again on saving; main masks secret-shaped text before writing.
 */

/** One labelled fact: `label：value`. */
export interface FeedbackLine {
  readonly label: string;
  readonly value: string;
}

/**
 * What the composer that opened the panel shows now, worded by the host. None of it is
 * the chat's or the task's content: the error in the window's words, the last failure by
 * its fixed codes, and the choices that shape a reply.
 */
export interface FeedbackContext {
  readonly scope: "chat" | "workbench";
  /** The error the window shows now; null when it shows none. */
  readonly error: string | null;
  /** The last failure by its fixed codes, never a service's own text; null when none. */
  readonly failure: readonly FeedbackLine[] | null;
  /** Model, effort, permission and the like. */
  readonly settings: readonly FeedbackLine[];
}

/** Each `/feedback` sends a new one; the panel opens with what the composer shows then. */
export interface FeedbackRequest {
  readonly nonce: number;
  readonly context: FeedbackContext;
}

/** What the panel adds by itself, read when it opens; null where it could not be read. */
export interface FeedbackEnvironment {
  readonly version: string | null;
  readonly system: SystemInfo | null;
  readonly theme: ThemePref;
  readonly appearance: Appearance;
  readonly motion: MotionPreference;
  /** The system asks for reduced motion, which keeps the motion off whatever the choice. */
  readonly reducedMotion: boolean;
  readonly language: InteractionLanguageChoice | null;
}

export type FeedbackDiagnostic = "error" | "failure" | "settings";

const UNKNOWN = "未知";

/** The Settings pane's words (Settings/WindowSettings.tsx, Settings/LanguageSettings.tsx). */
const THEME_WORDS: Record<ThemePref, string> = {
  dark: "深紫 · 星间书房",
  light: "浅色 · 白昼书房",
  system: "跟随系统",
};
const APPEARANCE_WORDS: Record<Appearance, string> = {
  observatory: "星间书房",
};
const MOTION_WORDS: Record<MotionPreference, string> = {
  system: "跟随系统 · 轻量动效",
  off: "关闭动效",
};
const LANGUAGE_WORDS: Record<InteractionLanguageChoice, string> = {
  follow: "跟随界面语言",
  zh: "中文",
  en: "English",
};
/** The model pickers' effort words (ComposerModelPicker.tsx, HertaChat.tsx). */
export const EFFORT_WORDS: Record<string, string> = {
  none: "关闭",
  enabled: "开启",
  low: "轻度",
  medium: "标准",
  high: "深度",
  max: "最高",
};
/** The workbench's 权限档位 options. */
export const PERMISSION_WORDS: Record<string, string> = {
  "read-only": "只读 / 讨论",
  "workspace-edit": "工作区编辑",
  "full-access": "完全访问",
};

const DIAGNOSTICS: readonly {
  readonly key: FeedbackDiagnostic;
  readonly title: string;
  readonly none: string;
}[] = [
  { key: "error", title: "错误提示", none: "当前没有错误提示" },
  { key: "failure", title: "最近一次失败", none: "没有记录到失败" },
  { key: "settings", title: "设置概要", none: "没有可列的设置" },
];

const INTRO =
  "整理成 Markdown，预览后由你选择保存位置；不会发送到任何地方。不会自动加入密钥与令牌、聊天与任务内容、附件与文件内容，路径中的用户名替换为 <用户>。";
const BATCH_NOTE =
  "各交付批次的版本号相同；知道安装的批次（例如 R122）可以写在描述里。";
const SAVE_NOTE =
  "保存时会再次把路径中的用户名替换为 <用户>，并遮蔽疑似密钥（如 API Key、令牌）。";
const SAVE_FAILED = "保存没有完成，反馈仍在这里，可以重试。";
const EXCLUDED =
  "未自动附带密钥与令牌、聊天与任务内容、附件与文件内容；路径中的用户名已替换为 <用户>，疑似密钥在保存时遮蔽。";

/**
 * "Windows 11（10.0.26200）· x64". Windows 11 still reports 10.0, so its build number
 * (22000 on) tells it from Windows 10.
 */
export function describeSystem(info: SystemInfo | null): string {
  if (!info) return UNKNOWN;
  const nt = /^10\.0\.(\d+)/.exec(info.release);
  const name =
    info.platform !== "win32"
      ? info.platform
      : !nt
        ? "Windows"
        : Number(nt[1]) >= 22000
          ? "Windows 11"
          : "Windows 10";
  return `${name}（${info.release}）· ${info.arch}`;
}

// A profile folder's name: what a Windows user name cannot hold ends it, as does the
// punctuation that usually follows a path in a sentence. Up to three words with spaces
// count when a separator follows them (C:\Users\Ann Lee\…); a name that ends the path
// is taken to its first space.
const NAME = String.raw`[^\s\\/:*?"<>|,;=+\[\]()，。；：！？、（）【】「」『』《》]+`;
const OWNER = String.raw`(?:${NAME}(?: ${NAME}){0,2}(?=[\\/])|${NAME})`;
const PROFILE_PATHS = [
  // C:\Users\name, C:/Users/name, C:\\Users\\name (JSON), C:\Documents and Settings\name
  new RegExp(
    String.raw`(\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+)${OWNER}`,
    "gi",
  ),
  // /home/name, /Users/name, /mnt/c/Users/name, where a path starts
  new RegExp(
    String.raw`((?:^|(?<=[\s"'(=:]))(?:/mnt/[A-Za-z])?/(?:home|Users)/)${OWNER}`,
    "gm",
  ),
];

/** The user name in a profile path becomes <用户>; the rest of the path stays. */
export function maskUserPaths(text: string): string {
  return PROFILE_PATHS.reduce(
    (out, pattern) => out.replace(pattern, "$1<用户>"),
    text,
  );
}

/** What the panel says by itself, in the Markdown's order. */
export function environmentLines(env: FeedbackEnvironment): FeedbackLine[] {
  return [
    { label: "应用版本", value: env.version ?? UNKNOWN },
    { label: "系统", value: describeSystem(env.system) },
    { label: "界面主题", value: THEME_WORDS[env.theme] ?? UNKNOWN },
    { label: "界面风格", value: APPEARANCE_WORDS[env.appearance] ?? UNKNOWN },
    {
      label: "界面动效",
      value: `${MOTION_WORDS[env.motion] ?? UNKNOWN}${env.reducedMotion ? "（系统已开启“减少动态效果”）" : ""}`,
    },
    {
      label: "对话语言",
      value: env.language ? LANGUAGE_WORDS[env.language] : UNKNOWN,
    },
  ];
}

/** What a diagnostic would add, line by line; null when the composer has none of it. */
export function diagnosticLines(
  context: FeedbackContext,
  key: FeedbackDiagnostic,
): string[] | null {
  const facts = (items: readonly FeedbackLine[] | null) =>
    items?.length ? items.map((l) => `${l.label}：${l.value}`) : null;
  switch (key) {
    case "error": {
      const text = context.error?.trim();
      return text ? text.split(/\r?\n/) : null;
    }
    case "failure":
      return facts(context.failure);
    case "settings":
      return facts(context.settings);
  }
}

/**
 * The feedback as Markdown: the description, what the panel adds by itself, the chosen
 * diagnostics and what is never in it. `now` and `timeZone` are injected so the output
 * is deterministic.
 */
export function buildFeedbackMarkdown(
  input: {
    readonly description: string;
    readonly context: FeedbackContext;
    readonly environment: FeedbackEnvironment;
    readonly include: ReadonlySet<FeedbackDiagnostic>;
  },
  opts: { readonly now: Date; readonly timeZone?: string },
): string {
  const where = input.context.scope === "chat" ? "黑塔聊天" : "工作台";
  const out = [
    "# The Herta 反馈",
    `写于 ${formatStamp(opts.now.toISOString(), opts.timeZone)} · ${where}`,
    "## 问题描述",
    input.description.trim(),
    "## 环境",
    environmentLines(input.environment)
      .map((l) => `- ${l.label}：${l.value}`)
      .join("\n"),
  ];
  const chosen = DIAGNOSTICS.flatMap(({ key, title }) => {
    const lines = input.include.has(key)
      ? diagnosticLines(input.context, key)
      : null;
    if (!lines) return [];
    const prefix = key === "error" ? "> " : "- ";
    return [`### ${title}`, lines.map((l) => prefix + l).join("\n")];
  });
  if (chosen.length) out.push("## 诊断", ...chosen);
  out.push("---", `*${EXCLUDED}*`);
  return maskUserPaths(`${out.join("\n\n")}\n`);
}

/** How long the panel waits for a read before it writes 未知. */
const READ_MS = 2000;

/** The value read, or null when it failed or took longer than `ms`. */
function within<T>(
  read: Promise<T> | undefined,
  ms: number,
): Promise<T | null> {
  if (!read) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    read.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function asSystem(value: unknown): SystemInfo | null {
  const v = value as Partial<SystemInfo> | null;
  return v &&
    typeof v.platform === "string" &&
    typeof v.release === "string" &&
    typeof v.arch === "string"
    ? { platform: v.platform, release: v.release, arch: v.arch }
    : null;
}

/**
 * The panel, one per composer. Each new `request` opens it with what that composer shows
 * then; the description, choices and edited preview stay until a save succeeds, so
 * closing it by mistake loses nothing written. Focus goes back where it was when it opened. A host
 * that hides (the chat, when the workbench takes over) passes `shown` false, which
 * closes it: a modal left open inside a hidden panel would leave the window inert.
 */
export function FeedbackPanel({
  request,
  shown = true,
}: {
  readonly request: FeedbackRequest | null;
  readonly shown?: boolean;
}) {
  const { bridge } = useHertaBridge();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const describe = useRef<HTMLTextAreaElement>(null);
  const preview = useRef<HTMLTextAreaElement>(null);
  // The composer, or the 快捷操作 button the menu handed focus to.
  const opener = useRef<HTMLElement | null>(null);
  const alive = useRef(true);
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [include, setInclude] = useState<ReadonlySet<FeedbackDiagnostic>>(
    () => new Set(),
  );
  const [environment, setEnvironment] = useState<FeedbackEnvironment | null>(
    null,
  );
  const [step, setStep] = useState<"write" | "preview">("write");
  const [generated, setGenerated] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<"saved" | "failed" | null>(null);
  const save = bridge.saveSessionExport;
  const context = request?.context ?? null;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (!request) return;
    const focused = document.activeElement;
    opener.current = focused instanceof HTMLElement ? focused : null;
    // A diagnostic the composer no longer has drops out of the choices.
    setInclude(
      (chosen) =>
        new Set(
          [...chosen].filter(
            (key) => diagnosticLines(request.context, key) !== null,
          ),
        ),
    );
    setOpen(true);
  }, [request]);
  useLayoutEffect(() => {
    const box = dialog.current;
    if (open && box && !box.open) box.showModal();
  }, [open]);
  useEffect(() => {
    const box = dialog.current;
    if (!shown && box?.hasAttribute("open")) box.close();
  }, [shown]);
  // Focus follows the step: the description to write, the Markdown to check.
  useEffect(() => {
    if (open) {
      const field = step === "write" ? describe.current : preview.current;
      field?.focus({ preventScroll: true });
    }
  }, [open, step]);
  useEffect(() => {
    if (!request) return;
    let current = true;
    setEnvironment(null);
    const local = {
      theme: themePref(),
      appearance: appearance(),
      motion: motionPreference(),
      reducedMotion:
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
    void Promise.all([
      within(bridge.getAppVersion?.(), READ_MS),
      within(bridge.getSystemInfo?.(), READ_MS),
      within(bridge.getInteractionLanguage?.(), READ_MS),
    ]).then(([version, system, language]) => {
      if (!current) return;
      setEnvironment({
        ...local,
        version: typeof version === "string" && version ? version : null,
        system: asSystem(system),
        language:
          language === "zh" || language === "en" || language === "follow"
            ? language
            : null,
      });
    });
    return () => {
      current = false;
    };
  }, [request, bridge]);
  if (!save) return null;
  const closed = () => {
    setOpen(false);
    if (result === "saved") {
      setStep("write");
      setDescription("");
      setInclude(new Set());
      setGenerated("");
      setText("");
    } else if (text === generated) setStep("write");
    // A hand-edited preview is the draft now. Closing or hiding must not silently
    // rebuild it from the description; only the explicit 返回修改 may discard it.
    setResult(null);
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  };
  const toPreview = () => {
    if (!context || !environment || !description.trim()) return;
    const markdown = buildFeedbackMarkdown(
      { description, context, environment, include },
      { now: new Date() },
    );
    setGenerated(markdown);
    setText(markdown);
    setResult(null);
    setStep("preview");
  };
  const store = async () => {
    if (saving || !text.trim()) return;
    setSaving(true);
    setResult(null);
    const day = formatStamp(new Date().toISOString()).slice(0, 10);
    let end: "saved" | "cancelled" | "failed";
    try {
      const r = await save(`The Herta 反馈 ${day}`, maskUserPaths(text));
      end = r.saved ? "saved" : r.failed === true ? "failed" : "cancelled";
    } catch {
      end = "failed";
    }
    if (!alive.current) return;
    setSaving(false);
    // Cancelling the dialog is not a failure: the preview stays as it was.
    setResult(end === "cancelled" ? null : end);
  };
  const toggle = (key: FeedbackDiagnostic, on: boolean) =>
    setInclude((chosen) => {
      const next = new Set(chosen);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  return (
    <dialog
      ref={dialog}
      className="herta-feedback"
      aria-label="反馈"
      // Esc waits for a save in progress, like the close button.
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={closed}
    >
      {open && context && (
        <>
          <header>
            <strong>反馈</strong>
            <button
              type="button"
              aria-label="关闭反馈"
              disabled={saving}
              onClick={() => dialog.current?.close()}
            >
              <Icon name="close" />
            </button>
          </header>
          {step === "write" ? (
            <>
              <p>{INTRO}</p>
              <label>
                问题描述（必填）
                <textarea
                  ref={describe}
                  value={description}
                  placeholder="发生了什么、怎样重现、期望的结果"
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <section aria-label="自动包含">
                <strong>自动包含</strong>
                {environment ? (
                  <ul>
                    {environmentLines(environment).map((l) => (
                      <li key={l.label}>
                        {l.label}：{l.value}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p role="status">正在读取…</p>
                )}
                <small>{BATCH_NOTE}</small>
              </section>
              <fieldset>
                <legend>可选诊断（默认不包含）</legend>
                {DIAGNOSTICS.map(({ key, title, none }) => {
                  const lines = diagnosticLines(context, key);
                  return (
                    <div key={key}>
                      <label>
                        <input
                          type="checkbox"
                          checked={lines !== null && include.has(key)}
                          disabled={lines === null}
                          aria-describedby={`${id}-${key}`}
                          onChange={(e) => toggle(key, e.target.checked)}
                        />
                        {title}
                      </label>
                      <pre id={`${id}-${key}`}>
                        {lines ? maskUserPaths(lines.join("\n")) : none}
                      </pre>
                    </div>
                  );
                })}
              </fieldset>
              <footer>
                <button
                  type="button"
                  disabled={!description.trim() || !environment}
                  onClick={toPreview}
                >
                  预览
                </button>
              </footer>
            </>
          ) : (
            <>
              <label>
                预览（可修改，保存的就是这里的文字）
                <textarea
                  ref={preview}
                  className="herta-feedback-preview"
                  value={text}
                  readOnly={saving}
                  onChange={(e) => {
                    if (saving) return;
                    setText(e.target.value);
                    setResult(null);
                  }}
                />
              </label>
              <small>{SAVE_NOTE}</small>
              {saving && <p role="status">正在保存…</p>}
              {result === "saved" && <p role="status">已保存。</p>}
              {result === "failed" && <p role="alert">{SAVE_FAILED}</p>}
              <footer>
                {text !== generated && result !== "saved" && (
                  <small>返回修改会放弃对预览的修改。</small>
                )}
                {result === "saved" ? (
                  <button type="button" onClick={() => dialog.current?.close()}>
                    完成
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => setStep("write")}
                    >
                      返回修改
                    </button>
                    <button
                      type="button"
                      disabled={saving || !text.trim()}
                      onClick={() => void store()}
                    >
                      保存…
                    </button>
                  </>
                )}
              </footer>
            </>
          )}
        </>
      )}
    </dialog>
  );
}
