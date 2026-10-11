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

const EXIT_MS = 180;

export interface SettingsModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly sessionId?: string;
}

const SECTIONS = [
  { key: "connections", label: "连接与模型" },
  { key: "appearance", label: "外观" },
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
}: SettingsModalProps): JSX.Element | null {
  const { bridge } = useHertaBridge();
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
  const navigate = (next: Section): void => {
    if (control.busy || next === section) return;
    if (control.dirty) setLeaveTo(next);
    else setSection(next);
  };
  const leave = (): void => {
    const target = leaveTo;
    setLeaveTo(null);
    setControl({ dirty: false, busy: false, save: async () => true });
    if (target === "close") onClose();
    else if (target) setSection(target);
  };
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
      setLeaving(true);
      const t = setTimeout(() => {
        setMounted(false);
        setLeaving(false);
      }, EXIT_MS);
      return () => clearTimeout(t);
    }
  }, [open, mounted]);

  // Every open starts on the first section — never remember the last-viewed
  // one (the component stays mounted while closed, so `section` would otherwise
  // persist). useLayoutEffect resets it before paint, so even reopening during
  // the close animation (still mounted) shows the first section with no flash.
  useLayoutEffect(() => {
    if (open) setSection(SECTIONS[0].key);
  }, [open]);

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
          .querySelector<HTMLElement>(".sidebar-settings")
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
        <div className="settings-content">
          <button
            type="button"
            className="settings-close"
            aria-label="返回任务"
            onClick={requestClose}
          >
            ×
          </button>
          <h2 className="settings-section-title">{active.label}</h2>
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
          {section === "workspace" && (
            <>
              <p className="settings-intro">
                项目通过侧栏的“打开项目文件夹”选择。打开项目不会自动授予执行权限。
              </p>
              <p className="settings-note">
                工作区信任与审批由主进程控制。保存连接不会触发项目读写；实际执行前检查目标项目与具体审批内容。
              </p>
            </>
          )}
          {section === "shortcuts" && (
            <>
              <p className="settings-intro">
                Ctrl+, 打开设置 · Escape 返回任务
              </p>
              <p>
                Enter 发送 · Shift+Enter 换行。中文输入法组合输入时 Enter
                只确认输入。
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
                第三轮：三协议请求、真实任务和工具接线。服务兼容性以当前模型的验证状态及本轮报告为准。
              </p>
              <p className="settings-note">
                原创几何占位；无角色图、语音或 3D。数据目录沿用
                HertaAtelier，改名不迁移或清除凭据。
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
