import type { NeutralMessage, ProviderConfig } from "./contracts.js";

export interface MessageImage {
  mimeType: "image/png" | "image/jpeg";
  data: string;
}

/** Conservative documented vision support; a compatible URL alone is insufficient. A model
 * outside that list qualifies only when an image probe on this connection read a picture back
 * (`capabilities.images`, reset to "unknown" whenever the connection is edited). Text and tool
 * probes never imply it. */
export function imageSupport(config: Pick<ProviderConfig, "baseURL" | "protocol"> & { readonly models?: ProviderConfig["models"] }, model: string): boolean {
  // Tolerates a partial view: a renderer builds its model list from this, and a throw empties it.
  if (config.models?.some(m => m.id === model && m.capabilities?.images === "supported")) return true;
  try {
    const u = new URL(config.baseURL);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || (u.port && u.port !== "443") || !["", "/v1"].includes(u.pathname.replace(/\/$/, ""))) return false;
    if (u.hostname === "api.openai.com" && ["openai-responses", "openai-chat-completions"].includes(config.protocol))
      return /^(gpt-4o(?:-mini)?|gpt-4\.1(?:-mini|-nano)?|gpt-5\.2|gpt-6-astra)(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
    return u.hostname === "api.anthropic.com" && config.protocol === "anthropic-messages" && /^claude-(sonnet-4(?:-[56])?|opus-4(?:-[1567])?|haiku-4-5|opus-5(?:-5)?)(?:-\d{8})?$/.test(model);
  } catch { return false; }
}

/** Local inline bytes only. Never accept URLs or arbitrary MIME types. */
export function validateMessageImage(value: unknown): MessageImage {
  const v = value as Partial<MessageImage> | null;
  if (!v || !["image/png", "image/jpeg"].includes(v.mimeType ?? "") || typeof v.data !== "string" || v.data.length > 2796204 || v.data.length < 16 || (v.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.data))) throw new Error("图片必须是2 MB以内的 PNG 或 JPEG。");
  const bytes = atob(v.data);
  if (bytes.length > 2 * 1024 * 1024 || (v.mimeType === "image/png" ? !bytes.startsWith("\x89PNG\r\n\x1a\n") : !bytes.startsWith("\xff\xd8\xff"))) throw new Error("图片内容与格式不匹配。");
  return { mimeType: v.mimeType as MessageImage["mimeType"], data: v.data };
}

export function imageDataURL(image: MessageImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

/** R110 (F06): a service refused a request that carried pictures. Only local facts decide — these
 * messages, as sent, had image blocks, and the HTTP status. The remote error body never does (its
 * code/type/param are diagnostics only), so "image-rejected" says the request was refused, not why;
 * 413 is a size refusal, never a capability one. Anything else is null and keeps its own words. */
export interface ImageRequestRefusal { readonly code: "image-rejected" | "image-too-large"; readonly status: number }
export function imageRequestRefusal(error: unknown, messages: readonly NeutralMessage[]): ImageRequestRefusal | null {
  if (!messages.some(m => m.role === "user" && (m.images?.length ?? 0) > 0)) return null;
  const e = error as { code?: unknown; status?: unknown } | null;
  if (!e || typeof e !== "object" || e.code !== "http") return null;
  if (e.status === 413) return { code: "image-too-large", status: 413 };
  return e.status === 400 || e.status === 415 || e.status === 422 ? { code: "image-rejected", status: e.status } : null;
}

/** What a surface reports for an "image-rejected" refusal: enough to mark that model for an image
 * re-check on the connection revision the request used, and to say where it happened. */
export interface ImageRequestRefused {
  readonly providerId: string;
  readonly providerRevision: number;
  readonly modelId: string;
  readonly status: number;
  readonly surface: "chat" | "workbench";
}
