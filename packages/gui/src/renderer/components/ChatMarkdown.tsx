import type {
  ChatAttachment,
  HertaChatMessage,
} from "../../shared/herta-chat.js";
import { chatFileMeta } from "./ChatAttachmentPreview.js";
import { formatStamp } from "./Sidebar/session-markdown.js";

/**
 * A chat as Markdown (F09 `/export`, R124), worded as the chat window words it: the
 * title, when it started and when it was exported, then each message — who, when, its
 * attachments by name and kind (never their contents) and its text whole. Where the
 * 续聊范围 starts, the window's own line, and the user's 续聊要点 where the model gets
 * them. Never the thinking, the search results or the memory. `now` and `timeZone`
 * are injected so the output is deterministic; main masks secret-shaped text before
 * writing it.
 */
export function buildChatMarkdown(
  chat: {
    readonly title: string;
    readonly messages: readonly HertaChatMessage[];
    readonly contextStart: number;
    readonly contextNote: string;
  },
  opts: { readonly now: Date; readonly timeZone?: string },
): string {
  const stamp = (iso: string) => formatStamp(iso, opts.timeZone);
  const title = chat.title.replace(/\s+/g, " ").trim() || "新聊天";
  const first = chat.messages[0]?.at;
  const out = [
    `# ${title}`,
    [
      ...(first ? [`开始于 ${stamp(first)}`] : []),
      `导出于 ${stamp(opts.now.toISOString())}`,
    ].join(" · "),
  ];
  // The 续聊范围 starts at the whole history, at a later message, or after the last one
  // (仅从下一条消息开始); the 续聊要点 go to the model at its start either way.
  const start = Math.min(chat.contextStart, chat.messages.length);
  const note = chat.contextNote.trim();
  const range = () => {
    if (start > 0)
      out.push("---", "*黑塔从这里开始参考；更早的内容只保留在记录中*");
    if (note) out.push(`**续聊要点**\n\n${note}`);
  };
  chat.messages.forEach((m, i) => {
    if (i === start) range();
    const parts = [
      [
        `**${m.role === "assistant" ? "黑塔" : "你"}**`,
        ...(m.at ? [stamp(m.at)] : []),
        ...(m.status === "complete" ? [] : [STATUS[m.status]]),
      ].join(" · "),
    ];
    if (m.attachments?.length)
      parts.push(`附件：${m.attachments.map(attachmentLine).join("、")}`);
    const text = m.text.trim();
    if (text) parts.push(text);
    out.push(parts.join("\n\n"));
  });
  if (start === chat.messages.length) range();
  return `${out.join("\n\n")}\n`;
}

/** The window's words for a message that did not complete. */
const STATUS: Record<
  Exclude<HertaChatMessage["status"], "complete">,
  string
> = {
  streaming: "正在回复…",
  cancelled: "已停止",
  interrupted: "上次回复已中断",
  failed: "回复未完成",
};

/** A file by name and kind, as its chip shows it; a picture says whether it still goes to the models. */
function attachmentLine(a: ChatAttachment): string {
  const picture =
    a.image !== undefined ||
    a.imageRef !== undefined ||
    a.imageDeferred === true ||
    a.imageMissing === true;
  const meta = picture
    ? a.modelUse === "stopped"
      ? "图片 · 不再发给模型"
      : "图片"
    : chatFileMeta(a);
  return `${a.name}（${meta}）`;
}
