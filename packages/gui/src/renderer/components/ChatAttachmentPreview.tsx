import { imageDataURL } from "@herta/providers/images";
import type { ChatAttachment } from "../../shared/herta-chat.js";
import { useHertaBridge } from "../context/HertaBridgeContext.js";
import { AttachmentTray, type TrayItem } from "./AttachmentTray.js";

/** What a chat file is, beside its name. */
export function chatFileMeta(attachment: ChatAttachment): string {
  if (attachment.format === "pdf")
    return attachment.pages ? `PDF · ${attachment.pages} 页` : "PDF";
  if (attachment.format === "docx") return "Word";
  return "文本";
}

/** A chat file's read-only content: the text that is (or was) sent for it. */
export function ChatFileText({
  attachment,
  pending = false,
}: {
  readonly attachment: ChatAttachment;
  readonly pending?: boolean;
}) {
  return (
    <>
      {attachment.format && (
        <p>
          {pending
            ? "发送提取文字，不含图片、原始版式与批注。请先检查内容。"
            : "提取文字 · 不含图片与原始版式"}
        </p>
      )}
      <pre>{attachment.text}</pre>
    </>
  );
}

const isPicture = (a: ChatAttachment) =>
  a.image !== undefined || a.imageDeferred === true || a.imageMissing === true;

/** F04 (R117): what stopping a chat picture does; the chat sends its whole range or nothing. */
const CHAT_MODEL_USE_HELP =
  "停用后预览与文件都保留，从下一次发送起不再发给模型，可随时恢复。续聊范围内的图片每次发送都会附带，最多 8 张、共 12 MiB，超出时消息不能发送。";

/**
 * A sent message's attachments, above its text (R78): its pictures as thumbnails that
 * open the shared viewer — history pictures are read as they scroll into view — then
 * its files as chips whose extracted text opens below. A message of the user's may let
 * each picture stop being sent to the model (F04, R117).
 */
export function ChatMessageAttachments({
  attachments,
  chatId,
  messageId,
  modelUse,
}: {
  readonly attachments: readonly ChatAttachment[];
  readonly chatId: string;
  readonly messageId: string;
  readonly modelUse?: {
    /** Whether the message is inside the continuation range the next send carries. */
    readonly inContext: boolean;
    readonly disabled: boolean;
    readonly note?: string;
    readonly onChange: (indexes: number[], use: "stop" | "send") => void;
  };
}) {
  const { bridge } = useHertaBridge();
  const items = attachments.map((a, index): TrayItem => {
    const key = `${messageId}:${index}`;
    if (!isPicture(a))
      return {
        key,
        name: a.name,
        meta: chatFileMeta(a),
        preview: <ChatFileText attachment={a} />,
      };
    const stopped = a.modelUse === "stopped";
    const use = modelUse && {
      stopped,
      status: stopped
        ? "不再发给模型"
        : modelUse.inContext
          ? "续聊时随消息发送"
          : "不在续聊范围内，不会发送",
    };
    return {
      key,
      name: a.name,
      picture: {
        ...(a.image
          ? { src: imageDataURL(a.image) }
          : a.imageMissing
            ? { missing: true }
            : {
                load: async () => {
                  if (!bridge.readHertaChatImage)
                    throw new Error("unavailable");
                  return imageDataURL(
                    await bridge.readHertaChatImage(chatId, messageId, index),
                  );
                },
              }),
        ...(use ? { modelUse: use } : {}),
      },
    };
  });
  return (
    <AttachmentTray
      label="这条消息的附件"
      items={[...items.filter((i) => i.picture), ...items.filter((i) => !i.picture)]}
      {...(modelUse
        ? {
            onModelUse: (keys: readonly string[], use: "stop" | "send") =>
              modelUse.onChange(
                keys.map((key) => Number(key.slice(messageId.length + 1))),
                use,
              ),
            modelUseHelp: CHAT_MODEL_USE_HELP,
            note: modelUse.note,
            disabled: modelUse.disabled,
          }
        : {})}
    />
  );
}
