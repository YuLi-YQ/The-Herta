import type { ProviderConfig } from "./contracts.js";

export interface MessageImage {
  mimeType: "image/png" | "image/jpeg";
  data: string;
}

/** Conservative documented vision support; a compatible URL alone is insufficient. */
export function imageSupport(config: Pick<ProviderConfig, "baseURL" | "protocol">, model: string): boolean {
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
