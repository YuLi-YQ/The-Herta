import { PluginSettings } from "../Plugins/PluginSettings.js";
import { Icon } from "../Icon.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { OVERLAY_Z, useModalOverlay } from "../../lib/overlay-stack.js";
import {
  type ProviderEditorControl,
  ProviderSettings,
} from "./ProviderSettings.js";
import { primeSettings } from "./settings-snapshot.js";
import { WindowSettings } from "./WindowSettings.js";

import { playEntrance } from "../../lib/gsap-motion.js";
import { useMotionPreference } from "../../lib/motion.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";

const EXIT_MS = 180;

export interface SettingsModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly sessionId?: string;
  /** Explicit-purpose entries override the remembered page on opening only. */
  readonly initialSection?: Section;
}

const SECTIONS = [
  { key: "connections", label: "连接与模型" },
  { key: "appearance", label: "外观" },
  { key: "plugins", label: "插件" },
  { key: "workspace", label: "工作区" },
  { key: "shortcuts", label: "快捷键" },
  { key: "about", label: "关于" },
] as const;
type Section = (typeof SECTIONS)[number]["key"];

/**
 * The Settings modal: a frosted full-window backdrop + a centered card with a
 * left section nav and a right content pane. Opened by the sidebar-foot Settings
 * button. Closes on Escape, an outside click, and the X. Focus moves into the
 * card on open and returns to the trigger on close. The nav is GROUPED —
 * 通用 (Language, Window), 黑塔 (Voice, Dream), 引擎 (DeepSeek, Coprocessor)
 * (SPEC 2026-06-23 settings-modal; regrouped per user feedback 2026-07-06).
 */
export function SettingsModal({
  open,
  onClose,
  sessionId,
  initialSection,
}: SettingsModalProps): JSX.Element | null {
  const { bridge } = useHertaBridge();
  const motion = useMotionPreference();
  const reducedMotion = useReducedMotion();
  const skipExit = motion === "off" || reducedMotion;
  // Prime the panes' last-known values (settings-snapshot.ts): once when the
  // app starts — this component is mounted, closed, from launch — and again
  // on every open, so each pane's FIRST frame shows the stored state instead
  // of a default it corrects a few frames later (owner 2026-09-18). A pane
  // mounts on a nav click, which no hand makes before these reads answer.
  useEffect(() => {
    primeSettings(bridge);
  }, [bridge]);
  useEffect(() => {
    if (open) primeSettings(bridge);
  }, [open, bridge]);
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const [section, setSection] = useState<Section>("connections");
  const [leaveTo, setLeaveTo] = useState<Section | "close" | null>(null);
  const [control, setControl] = useState<ProviderEditorControl>({
    dirty: false,
    busy: false,
    save: async () => true,
  });
  const onControl = useCallback(
    (next: ProviderEditorControl): void => setControl(next),
    [],
  );
  const requestClose = useCallback((): void => {
    if (control.busy) return;
    if (control.dirty) setLeaveTo("close");
    else onClose();
  }, [control.busy, control.dirty, onClose]);
  // A section picked from the nav fades its pane in like the other surface
  // swaps (R73). Only picks count: opening the card has its own entrance, so
  // the first section never fades twice.
  const [picks, setPicks] = useState(0);
  const pick = (next: Section): void => {
    setSection(next);
    setPicks((n) => n + 1);
  };
  const navigate = (next: Section): void => {
    if (control.busy || next === section) return;
    if (control.dirty) setLeaveTo(next);
    else pick(next);
  };
  const leave = (): void => {
    const target = leaveTo;
    setLeaveTo(null);
    setControl({ dirty: false, busy: false, save: async () => true });
    if (target === "close") onClose();
    else if (target) pick(target);
  };
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (picks === 0 || !el) return;
    const entrance = playEntrance(el, "panel");
    return () => {
      entrance?.revert();
    };
  }, [picks]);
  const active = SECTIONS.find((s) => s.key === section) ?? SECTIONS[0];
  const cardRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  // True while THIS open has taken focus, so the restore below runs only on
  // a real open→close — never on the initial mount (which would otherwise
  // focus the sidebar Settings button on app launch), and once per close.
  const focusTaken = useRef(false);

  // Mount on open; keep mounted through the exit animation, then unmount.
  useEffect(() => {
    if (open) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (mounted) {
      if (skipExit) {
        setMounted(false);
        setLeaving(false);
        return;
      }
      setLeaving(true);
      const t = setTimeout(() => {
        setMounted(false);
        setLeaving(false);
      }, EXIT_MS);
      return () => clearTimeout(t);
    }
  }, [open, mounted, skipExit]);

  // Generic Settings reopens the last page in this window. A connection-specific
  // entry still goes straight there; it must not bypass dirty-page guards while open.
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (open && !wasOpen.current && initialSection) setSection(initialSection);
    wasOpen.current = open;
  }, [open, initialSection]);

  // Focus the card on open; restore focus to the trigger on close — falling
  // back to the sidebar Settings button if the prior focus was lost to <body>.
  //
  // Keyed on `mounted` as well as `open`: from the closed state the card
  // does not exist in the flush that sees `open` — the mount effect above
  // only schedules it, and `if (!mounted) return null` renders nothing — so
  // a focus keyed on `open` alone found no card, the trap never engaged, and
  // Tab walked the workspace behind the backdrop (UX review 2026-09-22,
  // item 10). The restore is gated on `focusTaken`, so it never fires on the
  // initial mount and fires once per close.
  useEffect(() => {
    if (open && mounted && !focusTaken.current) {
      focusTaken.current = true;
      prevFocus.current = document.activeElement as HTMLElement | null;
      // No scroll on either hand-over: the card animates in, and what held
      // focus before may sit in a part of the window that is sliding.
      cardRef.current?.focus({ preventScroll: true });
    } else if (!open && focusTaken.current) {
      focusTaken.current = false;
      const prev = prevFocus.current;
      if (prev && prev !== document.body && document.contains(prev)) {
        prev.focus?.({ preventScroll: true });
      } else {
        document
          .querySelector<HTMLElement>(".herta-settings-button, .sidebar-settings")
          ?.focus?.({ preventScroll: true });
      }
    }
  }, [open, mounted]);

  // Overlay-stack registration: only the TOPMOST overlay owns Escape, so
  // closing Settings can never also feed the keypress to the approval panel
  // (which treats Escape as DENY) behind the backdrop.
  const isTop = useModalOverlay("settings", open, OVERLAY_Z.settings);

  // Escape (close) + Tab (focus trap) + outside-click close, only while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (!isTop) return; // a higher overlay (e.g. a card menu) owns Escape
        // An IME's Escape cancels its candidate; it must not close Settings
        // and discard the field being typed (R44).
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        requestClose();
        return;
      }
      if (e.key !== "Tab" || cardRef.current === null) return;
      // Keep Tab within the modal (aria-modal makes the background inert for AT;
      // this stops sighted keyboard focus from escaping behind the backdrop).
      // Disabled elements are skipped: focus() on a disabled control silently
      // no-ops, which would let Tab fall through the trap.
      const f = Array.from(
        cardRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !(el as HTMLButtonElement).disabled);
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === cardRef.current)) {
        e.preventDefault();
        // focus-scrolls: Tab navigation — the control must come into view.
        last?.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        // focus-scrolls: Tab navigation — the control must come into view.
        first?.focus();
      }
    };
    const onDown = (e: MouseEvent): void => {
      // App chrome is not "outside the modal" (audit 2026-07-24, M1). The
      // caption buttons live at z-4000 OUTSIDE `.app`'s stacking context, so
      // they are the only thing clickable over an open modal — by design —
      // and minimizing/maximizing the window read as a dismiss-click.
      if ((e.target as Element | null)?.closest?.(".window-controls")) return;
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        requestClose();
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, requestClose, isTop]);

  if (!mounted) return null;

  return (
    <div className={`settings-backdrop${leaving ? " is-out" : ""}`}>
      <div
        ref={cardRef}
        className="settings-card"
        role="dialog"
        aria-modal="true"
        aria-label="The Herta 设置"
        tabIndex={-1}
      >
        <nav className="settings-nav" aria-label="设置分组">
          <p className="settings-nav-eyebrow">The Herta</p>
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`settings-nav-item${section === s.key ? " is-active" : ""}`}
              aria-current={section === s.key}
              onClick={() => navigate(s.key)}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-content" ref={contentRef}>
          <button
            type="button"
            className="settings-close"
            aria-label="返回任务"
            onClick={requestClose}
          >
            <Icon name="close" />
          </button>
          <h1 className="settings-section-title">{active.label}</h1>
          {leaveTo && (
            <div className="provider-confirm" role="alert">
              <p>连接有未保存修改。保存后离开，或丢弃此次修改。</p>
              <button
                type="button"
                disabled={control.busy}
                onClick={async () => {
                  if (await control.save()) leave();
                }}
              >
                保存并离开
              </button>
              <button type="button" disabled={control.busy} onClick={leave}>
                丢弃并离开
              </button>
              <button type="button" onClick={() => setLeaveTo(null)}>
                继续编辑
              </button>
            </div>
          )}
          {section === "connections" && (
            <ProviderSettings
              sessionId={sessionId}
              onControl={onControl}
              onDone={requestClose}
            />
          )}
          {section === "appearance" && <WindowSettings />}
          {section === "plugins" && <PluginSettings />}
          {section === "workspace" && (
            <>
              <p className="settings-intro">
                项目从侧栏的“打开项目文件夹”选择。打开项目不会授予执行权限。
              </p>
              <p className="settings-note">
                写入与执行按输入区的权限档位处理，需要审批时逐项询问。
              </p>
            </>
          )}
          {section === "shortcuts" && (
            <>
              <p className="settings-intro">
                Ctrl+, 打开设置 · Escape 关闭设置并返回
              </p>
              <p>
                Ctrl+Enter 发送 · Enter 换行（工作台与聊天相同）。中文输入法组字时，Enter
                和 Escape 只作用于候选。
              </p>
              <p>
                工作台：Ctrl+N 新建任务 · Ctrl+O 打开项目文件夹 · Ctrl+L
                聚焦输入框 · Ctrl+Shift+E 收起或展开导航
              </p>
              <p className="settings-note">
                模型和执行权限可在输入区调整。
              </p>
            </>
          )}
          {section === "about" && (
            <>
              <p className="settings-intro">
                The Herta · 个人二次创作桌面编程助手
              </p>
              <p>
                工作台连接你配置的模型服务，在权限档位与审批下执行工具，并保留过程记录与文件差分；与黑塔聊天是独立的对话空间，有自己的历史、附件与记忆。
              </p>
              <p className="settings-note">
                数据保存在本机的 HertaAtelier 目录。欢迎页插画为二次创作素材。
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
