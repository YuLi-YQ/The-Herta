import { validateMessageImage, type MessageImage } from "@herta/providers/images";
export const chatFailures = {
  "search-limit":
    "本次搜索达到次数或续接上限，收到的内容已保留。可缩小问题范围后继续。",
  length:
    "回复额度已用尽，正文可能尚未生成。可降低思考强度、提高回复额度，或拆分问题后再发送。",
  timeout:
    "回复超时。复杂问题可能需要更长时间，可在连接设置中调整超时后再发送。",
  authentication: "服务拒绝访问，请检查 API Key 和账户权限。",
  "model-not-found": "请求端点或模型不存在，请检查协议、地址和模型 ID。",
  "rate-limit": "服务限流，请稍后再发送。",
  network: "无法连接模型服务，请检查网络与服务地址。",
  "stream-interrupted": "回复流中断，收到的正文已保留。可稍后再发送。",
  "protocol-incompatible":
    "服务返回了聊天模式不支持的工具调用；没有执行任何工具。",
  "empty-response":
    "服务结束了回复，但没有返回可显示的正文。请调整模型或回复额度后再发送。",
  "display-limit":
    "回复超过本地显示上限，已保留收到的正文。请将问题拆分后继续。",
  "service-unavailable":
    "模型服务未完成回复，收到的正文已保留。请检查服务状态后再发送。",
} as const;
export type HertaChatFailure = keyof typeof chatFailures;
export const chatOutputBudgets = [8192, 16384, 32768] as const;
export const defaultChatOutputBudget = 16384;
export interface HertaChatMessage {
  searches?: import("@herta/providers").WebSearchEvent[];
  attachments?: ChatAttachment[];
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  failure?: HertaChatFailure;
  reasoning?: string;
  reasoningTruncated?: boolean;
  status: "complete" | "streaming" | "cancelled" | "failed" | "interrupted";
}
export interface HertaChatListItem {
  id: string;
  title: string;
  updatedAt: string;
  pinned: boolean;
  archived: boolean;
  messageCount: number;
}
export interface HertaChatSnapshot {
  memory?: {
    enabled: boolean;
    items: { id: string; text: string; at: string; source: "user" | "idle" }[];
    status: string;
  };
  revision: number;
  activeId: string | null;
  chats: HertaChatListItem[];
  messages: HertaChatMessage[];
  contextStart: number;
  contextNote: string;
  contextCharacters: number;
  busy: boolean;
  error: string | null;
}
export interface HertaChatInput {
  webSearch?: boolean;
  attachments?: ChatAttachment[];
  chatId: string;
  text: string;
  providerId: string;
  modelId: string;
  maxOutputTokens?: number;
  reasoningEffort?: string;
}
export type ChatFileResult =
  | { ok: true; attachment: ChatAttachment }
  | { ok: false; message: string };
export interface ChatAttachment {
  image?: MessageImage;
  format?: "pdf" | "docx";
  pages?: number;
  name: string;
  text: string;
}
export function validateChatAttachments(value: unknown): ChatAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4)
    throw new Error("每条消息最多附加4个文件。");
  let total = 0;
  return value.map((item) => {
    if (
      !item ||
      typeof item.name !== "string" ||
      item.name.length > 180 ||
      /[\\/\x00-\x1f]/.test(item.name) ||
      typeof item.text !== "string" ||
      item.text.includes("\u0000") ||
      item.text.length > 32000
    )
      throw new Error("附件文本不得超过32000字，名称和内容必须有效。");
    total += item.text.length;
    if (total > 64000) throw new Error("附件总量不能超过64000字。");
    if (item.format !== undefined && !["pdf", "docx"].includes(item.format))
      throw new Error("附件格式无效。");
    if (
      item.pages !== undefined &&
      (!Number.isInteger(item.pages) || item.pages < 1 || item.pages > 100)
    )
      throw new Error("附件页数无效。");
    const image = item.image === undefined ? undefined : validateMessageImage(item.image);
    if (image && (item.text || item.format || item.pages)) throw new Error("图片附件不能混入文档内容。");
    return {
      ...(image ? { image } : {}),
      name: item.name,
      text: item.text,
      ...(item.format ? { format: item.format } : {}),
      ...(item.pages ? { pages: item.pages } : {}),
    };
  });
}
export type HertaChatAction =
  | { type: "activity" }
  | {
      type: "memory";
      operation: "save" | "delete" | "enable";
      id?: string;
      text?: string;
      enabled?: boolean;
    }
  | { type: "create" }
  | { type: "select" | "archive" | "restore"; id: string }
  | { type: "rename"; id: string; title: string }
  | { type: "pin"; id: string; pinned: boolean }
  | { type: "context"; id: string; keepTurns: number; note: string };

/** A turn starts with a user message; never split a user/reply pair. -1 means all. */
export function chatContextStart(
  messages: readonly HertaChatMessage[],
  keepTurns: number,
): number {
  if (keepTurns === -1) return 0;
  if (keepTurns === 0) return messages.length;
  const starts = messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
  return starts[Math.max(0, starts.length - keepTurns)] ?? 0;
}
