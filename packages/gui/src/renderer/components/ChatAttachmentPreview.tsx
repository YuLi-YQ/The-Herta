import { useEffect, useState } from "react";
import { imageDataURL } from "@herta/providers/images";
import type { ChatAttachment } from "../../shared/herta-chat.js";
import { useHertaBridge } from "../context/HertaBridgeContext.js";

function HistoryImage({ chatId, messageId, index, name }: { chatId: string; messageId: string; index: number; name: string }) {
  const { bridge } = useHertaBridge();
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setSource(undefined); setFailed(false);
    void (async () => {
      try {
        if (!bridge.readHertaChatImage) throw new Error();
        const image = await bridge.readHertaChatImage(chatId, messageId, index);
        if (alive) setSource(imageDataURL(image));
      } catch { if (alive) setFailed(true); }
    })();
    return () => { alive = false; };
  }, [bridge, chatId, messageId, index]);
  if (failed) return <p role="status">图片暂时无法读取。请检查图片目录；恢复后重新展开即可重试。</p>;
  return source ? <img className="herta-chat-image" alt={name} src={source} /> : <p role="status">正在读取图片…</p>;
}

export function ChatAttachmentPreview({ attachment, chatId, messageId, index }: {
  attachment: ChatAttachment; chatId: string; messageId: string; index: number;
}) {
  const [open, setOpen] = useState(false);
  return <details className="herta-chat-attachment" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>附件 · {attachment.name}{attachment.pages ? ` · ${attachment.pages}页` : ""}</summary>
    {attachment.format && <p>提取文字 · 不含图片与原始版式</p>}
    {open && (attachment.imageDeferred
      ? <HistoryImage chatId={chatId} messageId={messageId} index={index} name={attachment.name} />
      : attachment.image
        ? <img className="herta-chat-image" alt={attachment.name} src={imageDataURL(attachment.image)} />
        : attachment.imageMissing ? <p role="status">图片缺失或损坏，文字记录仍保留。</p> : <pre>{attachment.text}</pre>)}
  </details>;
}
