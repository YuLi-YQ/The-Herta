import type { ProviderConfig } from "./contracts.js";

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
