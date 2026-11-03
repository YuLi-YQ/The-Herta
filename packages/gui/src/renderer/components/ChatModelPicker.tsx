import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { chatOutputBudgets } from "../../shared/herta-chat.js";
import { useEntrance } from "../lib/gsap-motion.js";
import { Icon } from "./Icon.js";
import "../styles/chat-model-picker.css";

export interface ChatModelChoice {
  readonly key: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly label: string;
  readonly efforts: readonly string[];
}

const effortLabels: Record<string, string> = {
  none: "关闭",
  enabled: "开启",
  low: "轻度",
  medium: "标准",
  high: "深度",
  max: "最高",
};

/** Shares the workbench picker surface, not its persona/executor bindings. */
export function ChatModelPicker({
  target,
  shown,
  disabled,
  models,
  selected,
  effort,
  budget,
  onModel,
  onEffort,
  onBudget,
  onManage,
}: {
  target: string | null;
  shown: boolean;
  disabled: boolean;
  models: readonly ChatModelChoice[];
  selected: string;
  effort: string;
  budget: number;
  onModel: (key: string) => void;
  onEffort: (value: string) => void;
  onBudget: (value: number) => void;
  onManage: () => void;
}): JSX.Element {
  const [openTarget, setOpenTarget] = useState<string | null>(null);
  const open = Boolean(shown && !disabled && target && openTarget === target);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLElement>(null);
  const model = models.find((item) => item.key === selected);
  const current = useRef({ target, shown, disabled, open });
  current.current = { target, shown, disabled, open };
  useEntrance(popover, "popover-up", open);

  // Changing the chat or leaving the page closes the old chat's controls.
  useLayoutEffect(() => setOpenTarget(null), [target, shown, disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const first = popover.current?.querySelector<HTMLElement>(
      '.composer-model-option[aria-pressed="true"]',
    ) ?? popover.current?.querySelector<HTMLElement>(
      ".composer-model-option, .chat-model-manage",
    );
    first?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpenTarget(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      setOpenTarget(null);
      trigger.current?.focus({ preventScroll: true });
    };
    const blur = () => setOpenTarget(null);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("blur", blur);
    };
  }, [open]);
  const canChange = () => {
    const now = current.current;
    return now.open && now.shown && !now.disabled && now.target === target;
  };
  const groups = new Map<string, ChatModelChoice[]>();
  for (const item of models) {
    const group = groups.get(item.providerId) ?? [];
    group.push(item);
    groups.set(item.providerId, group);
  }
  return (
    <div className="composer-model-picker chat-model-picker" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="herta-model-status herta-chat-model"
        aria-label="聊天模型与回复设置"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled || !target || !shown}
        title={model?.label ?? "选择聊天模型"}
        onClick={() => setOpenTarget(open ? null : target)}
      >
        {model?.modelId ?? "选择模型"}
        {effort && model?.efforts.includes(effort)
          ? ` · ${effortLabels[effort] ?? effort}`
          : ""}{" "}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <section
          ref={popover}
          className="composer-model-popover chat-model-popover"
          role="dialog"
          aria-label="聊天模型与回复设置"
        >
          <header>
            <strong>聊天模型</strong>
            <button
              type="button"
              className="chat-model-close"
              aria-label="关闭模型选择"
              onClick={() => {
                setOpenTarget(null);
                trigger.current?.focus({ preventScroll: true });
              }}
            >
              <Icon name="close" />
            </button>
          </header>
          {[...groups].map(([providerId, items]) => (
            <div key={providerId}>
              <small>{items[0]?.providerName}</small>
              {items.map((item) => (
                <button
                  type="button"
                  key={item.key}
                  className="composer-model-option"
                  aria-label={item.label}
                  aria-pressed={selected === item.key}
                  title={item.label}
                  onClick={() => { if (canChange()) onModel(item.key); }}
                >
                  <span>{item.modelId}</span>
                  <span aria-hidden="true">{selected === item.key ? <Icon name="check" /> : null}</span>
                </button>
              ))}
            </div>
          ))}
          {!models.length && <p>暂无已验证的聊天模型。</p>}
          {!!model?.efforts.length && (
            <label className="chat-model-field">
              思考强度
              <select
                aria-label="聊天思考强度"
                value={effort}
                onChange={(event) => {
                  const value = event.target.value;
                  if (canChange() && (!value || model.efforts.includes(value))) onEffort(value);
                }}
              >
                <option value="">服务默认</option>
                {model.efforts.map((value) => (
                  <option key={value} value={value}>{effortLabels[value] ?? value}</option>
                ))}
              </select>
            </label>
          )}
          <label className="chat-model-field">
            回复额度
            <select
              aria-label="回复额度"
              value={budget}
              title="单次请求的输出 tokens 上限，可能包含模型思考；上限不等于实际消耗。"
              onChange={(event) => {
                const value = Number(event.target.value);
                if (canChange() && (chatOutputBudgets as readonly number[]).includes(value)) onBudget(value);
              }}
            >
              {chatOutputBudgets.map((value) => (
                <option key={value} value={value}>{value / 1024}k</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="chat-model-manage"
            onClick={() => {
              if (!canChange()) return;
              setOpenTarget(null);
              onManage();
            }}
          >
            管理连接与模型
          </button>
        </section>
      )}
    </div>
  );
}
