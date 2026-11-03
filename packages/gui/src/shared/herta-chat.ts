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
  // R110 (F06): a refused request that carried pictures (imageRequestRefusal); older versions
  // drop a code they do not know when loading.
  "image-rejected":
    "服务拒绝了这次附带图片的请求，原因未确认：可能与图片有关，也可能是请求的其他内容；识图能力没有被自动更改。可在“连接与模型”中重新测试识图。图片仍在续聊范围内，之后发送会再次附带；如需不带图片继续，可在图片下选择“不再发给模型”，或调整续聊范围、新建聊天。不会自动重发。",
  "image-too-large":
    "服务以请求过大（HTTP 413）拒绝了这次附带图片的请求；这不说明模型不支持识图，识图状态未更改。图片仍在续聊范围内，之后发送会再次附带；可在部分图片下选择“不再发给模型”、调整续聊范围或新建聊天，改用较小或较少的图片。不会自动重发。",
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
export interface ChatImageAudit {
  complete: boolean;
  current: number;
  backupOnly: number;
  unreferenced: number;
  unreferencedBytes: number;
  missing: number;
  checkedBackups: number;
}
/** One restorable set of chat images moved out of the library (R43). */
export interface ChatImageBatch {
  id: string;
  at: string;
  files: number;
  bytes: number;
}
export interface ChatStorageUsage {
  audit?: ChatImageAudit;
  quarantine?: ChatImageBatch[];
  checkedAt: string;
  historyBytes: number;
  historyLimitBytes: number;
  /** `others`: entries in the image library that are not plain files (a folder, a link), neither
   *  followed nor counted (R52). `invalid`: the library itself is not a plain folder (R53). */
  images: { bytes: number; files: number; limitBytes: number; others?: number; invalid?: true };
}
export interface HertaChatSnapshot {
  /** User-owned goal for the selected chat; corrupt values are preserved for explicit recovery. */
  goal?: import("@herta/core").GoalView;
  storage?: ChatStorageUsage;
  /** Image cleanup preview awaiting confirmation, and the last cleanup outcome. */
  imageCleanup?: {
    preview?: { token: string; files: number; bytes: number; expiresAt: string };
    notice?: string;
  };
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
  /** Renderer-only marker: bytes are requested only when the preview opens. */
  imageDeferred?: true;
  imageMissing?: true;
  imageRef?: { storage: "sha256"; sha256: string; mimeType: "image/png" | "image/jpeg" };
  image?: MessageImage;
  format?: "pdf" | "docx";
  pages?: number;
  /** F04 (R117): a sent picture the user stopped sending to the models. Any other value, from a
   *  later version, is kept and sent as before. */
  modelUse?: string;
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
    if (item.imageDeferred !== undefined) throw new Error("请重新上传图片文件。");
    total += item.text.length;
    if (total > 64000) throw new Error("附件总量不能超过64000字。");
    if (item.format !== undefined && !["pdf", "docx"].includes(item.format))
      throw new Error("附件格式无效。");
    if (
      item.pages !== undefined &&
      (!Number.isInteger(item.pages) || item.pages < 1 || item.pages > 100)
    )
      throw new Error("附件页数无效。");
    if (item.imageMissing !== undefined || item.imageRef !== undefined) {
      if ((item.imageMissing !== undefined && item.imageMissing !== true) || item.image || item.text || item.format || !item.imageRef || item.imageRef.storage !== "sha256" || !/^[a-f0-9]{64}$/.test(item.imageRef.sha256) || !["image/png", "image/jpeg"].includes(item.imageRef.mimeType)) throw new Error("图片引用无效。");
    }
    const image = item.image === undefined ? undefined : validateMessageImage(item.image);
    if (image && (item.text || item.format || item.pages)) throw new Error("图片附件不能混入文档内容。");
    return {
      ...(image ? { image } : {}),
      ...(item.imageRef ? { ...(item.imageMissing ? { imageMissing: true as const } : {}), imageRef: { storage: "sha256" as const, sha256: item.imageRef.sha256, mimeType: item.imageRef.mimeType } } : {}),
      name: item.name,
      text: item.text,
      ...(item.format ? { format: item.format } : {}),
      ...(item.pages ? { pages: item.pages } : {}),
      // Only a picture keeps it; a damaged value is left out rather than failing the history.
      ...((image || item.imageRef) &&
      typeof item.modelUse === "string" &&
      /^[a-z_]{1,32}$/.test(item.modelUse)
        ? { modelUse: item.modelUse }
        : {}),
    };
  });
}
export type HertaChatAction =
  | { type: "activity" }
  | { type: "storage" }
  | { type: "image-preview" }
  | { type: "image-isolate"; token: string }
  | { type: "image-restore" | "image-discard"; id: string }
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
  | {
      type: "context";
      id: string;
      /** -2 preserves the authoritative saved boundary; other values select a turn count. */
      keepTurns: number;
      note: string;
      expectedRevision?: number;
    }
  /** F04 (R117): stop sending pictures of one sent message to the models, or send them again. */
  | {
      type: "picture-use";
      id: string;
      messageId: string;
      indexes: number[];
      use: "stop" | "send";
    };

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

/** A generated note is only an editable draft; saving still uses the context action. */
export interface DraftChatContextInput {
  readonly chatId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  /** -2 preserves the authoritative saved boundary; never provide an absolute message index. */
  readonly keepTurns: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly providerRevision: number;
  readonly reasoningEffort?: string;
}
export interface CancelChatContextDraftInput {
  readonly chatId: string;
  readonly requestId: string;
}
export type DraftChatContextFailure =
  | "invalid"
  | "no_target"
  | "busy"
  | "conflict"
  | "cancelled"
  | "no_content"
  | "input_limit"
  | "output_limit"
  | "configuration"
  | "provider"
  | "storage";
export type DraftChatContextReply =
  | {
      readonly ok: true;
      readonly chatId: string;
      readonly requestId: string;
      readonly revision: number;
      readonly keepTurns: number;
      readonly boundaryIndex: number;
      readonly text: string;
      readonly providerId: string;
      readonly modelId: string;
      readonly providerRevision: number;
      readonly generatedAt: string;
    }
  | {
      readonly ok: false;
      readonly reason: DraftChatContextFailure;
      readonly message: string;
      readonly code?: HertaChatFailure;
    };
