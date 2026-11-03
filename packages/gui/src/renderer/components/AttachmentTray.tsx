import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import "../styles/attachments.css";
import { Icon } from "./Icon.js";
import { ImageLightbox } from "./Workspace/ImageLightbox.js";

/** One attachment of a message, sent or still waiting in a composer (R78). */
export interface TrayItem {
  readonly key: string;
  readonly name: string;
  /** A picture: its source now, how to read it once it comes into view (history), or gone. */
  readonly picture?: {
    readonly src?: string;
    readonly load?: () => Promise<string>;
    readonly missing?: boolean;
    /** F04 (R116): a sent picture the user may stop sending to the models — whether it is
     *  stopped, and what the latest request did with it, in words. */
    readonly modelUse?: { readonly stopped: boolean; readonly status?: string };
  };
  /** What a file is, beside its name ("PDF · 3 页"). */
  readonly meta?: string;
  /** What opening a file chip shows: its extracted text, read-only. */
  readonly preview?: ReactNode;
  /** A file still being read, or one that could not be added. */
  readonly state?: "reading" | "failed";
  readonly error?: string;
  /** A failed card with nothing left to retry (a paste whose bytes were not kept, R99). */
  readonly retry?: false;
}

/** F04 (R116): what stopping a picture does, on each switch. */
const MODEL_USE_HELP =
  "停用后预览与文件都保留，从下一次请求起不再发给模型，可随时恢复。每次请求最多发送 8 张图片、共 12 MiB：本条消息的图片优先，其次是较新的。";

/**
 * The attachments of one message: pictures as thumbnails that open the shared viewer,
 * other files as chips whose content opens below. In a composer each item also has its
 * own remove (or cancel / retry) control, apart from what it acts on (R78). In a sent
 * message a picture may carry a switch that stops sending it to the models (F04, R116).
 */
export function AttachmentTray({
  items,
  label,
  onRemove,
  onCancel,
  onRetry,
  onModelUse,
  modelUseHelp = MODEL_USE_HELP,
  note,
  disabled = false,
}: {
  readonly items: readonly TrayItem[];
  /** The group's accessible name. */
  readonly label: string;
  readonly onRemove?: (key: string) => void;
  readonly onCancel?: (key: string) => void;
  readonly onRetry?: (key: string) => void;
  /** F04 (R116): stop sending these pictures to the models, or send them again. */
  readonly onModelUse?: (keys: readonly string[], use: "stop" | "send") => void;
  /** What stopping does where the tray is shown (the chat sends by its own rule, R117). */
  readonly modelUseHelp?: string;
  /** Why the last change asked here did not happen, said under the tray. */
  readonly note?: string;
  /** Removing, retrying and switching wait while a message is being sent. */
  readonly disabled?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const id = useId();
  if (!items.length) return null;
  const opened = items.find((i) => i.key === open && i.preview !== undefined);
  const switchable = onModelUse ? items.filter((i) => i.picture?.modelUse) : [];
  const allStopped = switchable.every((i) => i.picture?.modelUse?.stopped);
  return (
    <div className="herta-attachments" role="group" aria-label={label}>
      {switchable.length > 0 && (
        <span id={`${id}help`} hidden>
          {modelUseHelp}
        </span>
      )}
      <ul>
        {items.map((item, index) => (
          <li
            key={item.key}
            className={`herta-attachment ${item.picture ? "is-picture" : "is-file"}${item.state ? ` is-${item.state}` : ""}${onModelUse && item.picture?.modelUse ? ` has-model-use${item.picture.modelUse.stopped ? " is-stopped" : ""}` : ""}`}
          >
            {item.state !== undefined ? (
              <span
                className="herta-attachment-file"
                title={item.state === "failed" ? `${item.name} 未添加：${item.error ?? ""}` : item.name}
              >
                <Icon name="file" />
                <span className="herta-attachment-name">{item.name}</span>
                {/* A composer announces its own reading state; a failure is said here. */}
                <span className="herta-attachment-meta" role={item.state === "failed" ? "alert" : undefined}>
                  {item.state === "failed" ? `未添加：${item.error ?? "附件未能读取。"}` : "正在读取…"}
                </span>
              </span>
            ) : item.picture ? (
              <Thumbnail item={item} />
            ) : item.preview === undefined ? (
              // Nothing to open (a file not read yet, or one without text): a label, not a dead button.
              <span className="herta-attachment-file" title={item.name}>
                <Icon name="file" />
                <span className="herta-attachment-name">{item.name}</span>
                {item.meta && <span className="herta-attachment-meta">{item.meta}</span>}
              </span>
            ) : (
              <button
                type="button"
                className="herta-attachment-file"
                title={item.name}
                aria-label={`${open === item.key ? "收起" : "查看"} ${item.name}`}
                aria-expanded={open === item.key}
                onClick={() => setOpen((o) => (o === item.key ? null : item.key))}
              >
                <Icon name="file" />
                <span className="herta-attachment-name">{item.name}</span>
                {item.meta && <span className="herta-attachment-meta">{item.meta}</span>}
              </button>
            )}
            {onModelUse && item.picture?.modelUse && (
              <ModelUse
                name={item.name}
                use={item.picture.modelUse}
                statusId={`${id}s${index}`}
                helpId={`${id}help`}
                help={modelUseHelp}
                disabled={disabled}
                onChange={(use) => onModelUse([item.key], use)}
              />
            )}
            {item.state === "failed" && item.retry !== false && onRetry && (
              <button
                type="button"
                className="herta-attachment-retry"
                aria-label={`重试添加 ${item.name}`}
                disabled={disabled}
                onClick={() => onRetry(item.key)}
              >
                重试
              </button>
            )}
            {item.state === "reading"
              ? onCancel && (
                  <button
                    type="button"
                    className="herta-attachment-remove"
                    aria-label={`取消添加 ${item.name}`}
                    title={`取消添加 ${item.name}`}
                    onClick={() => onCancel(item.key)}
                  >
                    <Icon name="close" />
                  </button>
                )
              : onRemove && (
                  <button
                    type="button"
                    className="herta-attachment-remove"
                    aria-label={`移除 ${item.name}`}
                    title={`移除 ${item.name}`}
                    disabled={disabled}
                    onClick={() => onRemove(item.key)}
                  >
                    <Icon name="close" />
                  </button>
                )}
          </li>
        ))}
      </ul>
      {switchable.length > 1 && (
        <div className="herta-attachments-actions">
          <button
            type="button"
            aria-describedby={`${id}help`}
            title={modelUseHelp}
            disabled={disabled}
            onClick={() =>
              onModelUse?.(
                switchable
                  .filter((i) => i.picture?.modelUse?.stopped === allStopped)
                  .map((i) => i.key),
                allStopped ? "send" : "stop",
              )
            }
          >
            {allStopped ? "本条图片都恢复发给模型" : "本条图片都不再发给模型"}
          </button>
        </div>
      )}
      {note && (
        <p className="herta-attachments-note" role="alert">
          {note}
        </p>
      )}
      {opened && (
        <section className="herta-attachment-preview" aria-label={`${opened.name} 的内容`}>
          <header>
            <span title={opened.name}>{opened.name}</span>
            <button type="button" aria-label={`收起 ${opened.name}`} onClick={() => setOpen(null)}>
              <Icon name="close" />
            </button>
          </header>
          {opened.preview}
        </section>
      )}
    </div>
  );
}

/** F04 (R116): under a sent picture, what the latest request did with it and the switch that
 *  stops sending it to the models. The switch keeps its place (and focus) when it flips. */
function ModelUse({
  name,
  use,
  statusId,
  helpId,
  help,
  disabled,
  onChange,
}: {
  readonly name: string;
  readonly use: { readonly stopped: boolean; readonly status?: string };
  readonly statusId: string;
  readonly helpId: string;
  readonly help: string;
  readonly disabled: boolean;
  readonly onChange: (use: "stop" | "send") => void;
}) {
  const action = use.stopped ? "恢复发给模型" : "不再发给模型";
  return (
    <>
      {use.status && (
        <span className="herta-attachment-status" id={statusId}>
          {use.status}
        </span>
      )}
      <button
        type="button"
        className="herta-attachment-use"
        aria-label={`${action}：${name}`}
        aria-describedby={use.status ? `${statusId} ${helpId}` : helpId}
        title={help}
        disabled={disabled}
        onClick={() => onChange(use.stopped ? "send" : "stop")}
      >
        {action}
      </button>
    </>
  );
}

/** A picture's thumbnail. A history picture is read only once it scrolls near view, so
 *  opening a long chat does not decode every picture in it. */
function Thumbnail({ item }: { readonly item: TrayItem }) {
  const button = useRef<HTMLButtonElement>(null);
  const load = useRef(item.picture?.load);
  load.current = item.picture?.load;
  const [loaded, setLoaded] = useState<string>();
  const [failed, setFailed] = useState(false);
  // A picture whose copy is gone fails to load: it is then said to be missing.
  const [broken, setBroken] = useState(false);
  const [viewing, setViewing] = useState(false);
  const src = broken ? undefined : (item.picture?.src ?? loaded);
  const deferred = item.picture?.load !== undefined;
  useEffect(() => {
    if (src !== undefined || failed || !deferred) return;
    let alive = true;
    const start = () => {
      const read = load.current;
      if (!read) return;
      read().then(
        (value) => alive && setLoaded(value),
        () => alive && setFailed(true),
      );
    };
    const element = button.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      start();
      return () => {
        alive = false;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          start();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [src, failed, deferred]);
  const missing = item.picture?.missing === true || failed || broken;
  return (
    <>
      <button
        ref={button}
        type="button"
        className="herta-attachment-thumb"
        aria-label={missing ? `${item.name}：图片缺失或无法读取` : `查看图片 ${item.name}`}
        title={missing ? `${item.name}：图片缺失或无法读取，文字记录仍保留` : item.name}
        disabled={src === undefined}
        onClick={() => setViewing(true)}
      >
        {src !== undefined ? (
          <img src={src} alt="" draggable={false} onError={() => setBroken(true)} />
        ) : (
          <span className="herta-attachment-placeholder">{missing ? "图片缺失" : "读取中"}</span>
        )}
      </button>
      {viewing && src !== undefined && (
        <ImageLightbox
          image={{ path: `attachment:${item.key}`, name: item.name, src }}
          onClose={() => {
            setViewing(false);
            button.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}
