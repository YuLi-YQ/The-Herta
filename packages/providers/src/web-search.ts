import type { NeutralMessage, ProviderConfig } from "./contracts.js";

/** Only explicitly adapted official endpoints. A compatible protocol alone is not evidence. */
export function webSearchSupport(
  config: Pick<ProviderConfig, "baseURL" | "protocol">,
  model: string,
): boolean {
  let url: URL;
  try {
    url = new URL(config.baseURL);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    return false;
  const path = url.pathname.replace(/\/$/, "");
  if (config.protocol === "openai-chat-completions" && url.hostname === "api.deepseek.com" && ["", "/v1"].includes(path))
    return /^(deepseek-flash|deepseek-v4-pro|deepseek-chat|deepseek-reasoner)$/.test(model);
  if (config.protocol === "anthropic-messages") {
    if (url.hostname === "api.deepseek.com" && path === "/anthropic")
      return /^(deepseek-flash|deepseek-v4-pro)(\[1m\])?$/.test(model);
    if (url.hostname === "api.anthropic.com" && ["", "/v1"].includes(path))
      return /^claude-(sonnet-4|opus-4|haiku-4-5|opus-5)(-|$)/.test(model);
  }
  if (
    config.protocol === "openai-responses" &&
    url.hostname === "api.openai.com" &&
    ["", "/v1"].includes(path)
  )
    return /^(gpt-4\.1(?:-mini)?|gpt-5(?:\.[1245])?(?:-mini)?|gpt-6-astra)(?:-\d{4}-\d{2}-\d{2})?$/.test(
      model,
    );
  return false;
}

export interface WebSearchEvent {
  type: "web-search";
  id: string;
  status: "searching" | "completed" | "failed" | "citation";
  query?: string;
  sources?: { url: string; title: string }[];
  error?: string;
  /** Present when the operation read one page (DeepSeek Fetch) instead of searching. */
  kind?: "fetch";
}

export function webSource(
  value: unknown,
): { url: string; title: string } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.url !== "string" || raw.url.length > 4096) return null;
  try {
    const url = new URL(raw.url);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    return {
      url: url.href,
      title:
        typeof raw.title === "string" ? raw.title.slice(0, 300) : url.hostname,
    };
  } catch {
    return null;
  }
}

export function boundedSearchEvents(value: unknown): WebSearchEvent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap((raw) => {
    if (
      !raw ||
      raw.type !== "web-search" ||
      typeof raw.id !== "string" ||
      !["searching", "completed", "failed", "citation"].includes(raw.status)
    )
      return [];
    return [
      {
        type: "web-search" as const,
        id: raw.id.slice(0, 200),
        status: raw.status,
        ...(typeof raw.query === "string"
          ? { query: raw.query.slice(0, 1000) }
          : {}),
        ...(typeof raw.error === "string"
          ? { error: raw.error.slice(0, 100) }
          : {}),
        ...(raw.kind === "fetch" ? { kind: "fetch" as const } : {}),
        sources: Array.isArray(raw.sources)
          ? raw.sources.slice(0, 20).flatMap((s: unknown) => {
              const safe = webSource(s);
              return safe ? [safe] : [];
            })
          : [],
      },
    ];
  });
}

const SEARCH_CHARS = 128;
const FOLLOW_UP_CHARS = 20;
const firstChars = (text: string, limit: number) =>
  Array.from(text).slice(0, limit).join("");

/** Search wording without code: fenced and inline code removed, whitespace collapsed, links kept. */
function searchWords(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || text.replace(/\s+/g, " ").trim();
}

/**
 * DeepSeek Search input for the latest user message. The cleaned question
 * leads; a short follow-up borrows the previous question's opening so
 * "那它的价格呢？" keeps its topic. `original` is the user's own wording.
 */
export function deepSeekSearchInput(
  messages: readonly NeutralMessage[],
): { query: string; original: string } | null {
  const latest = messages.at(-1);
  if (latest?.role !== "user" || !latest.text.trim()) return null;
  let query = searchWords(latest.text);
  if (Array.from(query).length <= FOLLOW_UP_CHARS) {
    const previous = messages
      .slice(0, -1)
      .reverse()
      .find((m) => m.role === "user" && m.text.trim());
    if (previous?.role === "user")
      query = `${query} ${searchWords(previous.text)}`;
  }
  return {
    query: firstChars(query, SEARCH_CHARS).trim(),
    original: firstChars(latest.text.trim(), SEARCH_CHARS),
  };
}

export function mergeSearchEvent(
  items: WebSearchEvent[],
  event: WebSearchEvent,
): void {
  const safe = boundedSearchEvents([event])[0];
  if (!safe) return;
  const index = items.findIndex((item) => item.id === safe.id);
  if (index >= 0) items[index] = { ...items[index], ...safe };
  else if (items.length < 64) items.push(safe);
}
