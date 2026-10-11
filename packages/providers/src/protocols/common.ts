import type { ModelRequest, ProviderConfig } from "../contracts.js";
import { type ProviderErrorCode, ProviderError } from "../errors.js";
import { isTlsOrProxyFailure, providerFetch } from "../transport.js";

export type Json = Record<string, unknown>;
export function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw failure("Invalid protocol object");
  return value as Json;
}
export function failure(
  message: string,
  code: ProviderErrorCode = "sse",
): ProviderError {
  return new ProviderError({ code, message, retryable: false });
}
export function string(value: unknown): string {
  if (typeof value !== "string") throw failure("Missing protocol string");
  return value;
}
export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/** Bounded diagnostics: never expose remote message, response body or headers. */
async function httpDiagnostic(
  response: Response,
  key: string | null,
  requestBody?: unknown,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "",
    bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 32768) return "";
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const json = object(JSON.parse(text));
    const error = object(json.error ?? json);
    const fields = ["code", "type", "param"].flatMap((field) => {
      const value = error[field];
      return typeof value === "string" &&
        /^[A-Za-z0-9_.[\]-]{1,120}$/.test(value) &&
        (!key || !value.includes(key))
        ? [`${field}=${value}`]
        : [];
    });
    if (typeof error.message === "string") {
      const message = error.message.toLowerCase();
      const keywords = [
        "type",
        "schema",
        "additionalProperties",
        "required",
        "max_output_tokens",
        "input",
        "tools",
        "description",
        "content",
        "format",
        "enum",
        "minimum",
        "maximum",
        "oneOf",
        "anyOf",
        "$schema",
        "pattern",
        "ref",
        "length",
        "tokens",
      ];
      const labels = keywords
        .filter((keyword) => message.includes(keyword.toLowerCase()))
        .map((keyword) => `field:${keyword}`);
      if (requestBody && typeof requestBody === "object") {
        const rawTools = (requestBody as Json).tools;
        if (Array.isArray(rawTools))
          for (const rawTool of rawTools) {
            const tool = object(rawTool);
            const name =
              tool.name ?? (tool.function && object(tool.function).name);
            if (
              typeof name === "string" &&
              /^[A-Za-z0-9_-]{1,64}$/.test(name) &&
              (!key || !name.includes(key)) &&
              message.includes(name.toLowerCase())
            )
              labels.push(`tool:${name}`);
          }
      }
      if (labels.length)
        fields.push(
          `diagnostic=${[...new Set(labels)].slice(0, 40).join("|")}`,
        );
    }
    return fields.length ? ` (${fields.join(", ")})` : "";
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function endpoint(config: ProviderConfig, path: string): URL {
  let url: URL;
  try {
    url = new URL(config.baseURL);
  } catch {
    throw failure("Invalid API root URL");
  }
  const local =
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    /^127\./.test(url.hostname);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && (local || config.allowRemoteHTTP))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /\/(responses|chat\/completions|messages|models)\/?$/.test(url.pathname)
  ) {
    throw failure(
      "Invalid API root; configure a root URL, not a complete endpoint",
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}`;
  return url;
}
export class Transport {
  constructor(
    readonly config: ProviderConfig,
    readonly key: string | null,
    readonly fetchImpl = providerFetch(),
  ) {}
  async request(
    url: URL,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<Response> {
    signal.throwIfAborted();
    if (this.config.authentication === "api-key" && !this.key?.trim())
      throw new ProviderError({
        code: "missing-key",
        message: "Provider API key is missing",
        retryable: false,
      });
    const headers: Record<string, string> = {
      Accept: body === undefined ? "application/json" : "text/event-stream",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.config.protocol === "anthropic-messages") {
      headers["anthropic-version"] = "2023-06-01";
      if (this.config.authentication === "api-key")
        headers["x-api-key"] = this.key as string;
    } else if (this.config.authentication === "api-key")
      headers.Authorization = `Bearer ${this.key}`;
    try {
      const response = await this.fetchImpl(url, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        const diagnostic = await httpDiagnostic(response, this.key, body);
        throw new ProviderError({
          code: "http",
          status: response.status,
          message: `Provider HTTP ${response.status}${diagnostic}`,
          retryable: false,
        });
      }
      return response;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ProviderError) throw error;
      throw new ProviderError({
        code: isTlsOrProxyFailure(error) ? "network-tls" : "network",
        message: "Provider transport failed; no automatic replay",
        retryable: false,
      });
    }
  }
  timed(signal: AbortSignal): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(
      () =>
        controller.abort(
          new ProviderError({
            code: "stall",
            message: "Provider request timed out",
            retryable: false,
          }),
        ),
      this.config.defaults.timeoutMs,
    );
    return {
      signal: controller.signal,
      dispose: () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      },
    };
  }
}

/** SSE framing accepts UTF-8 split bytes, CRLF, comments, and multi-line data. */
export async function* sse(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<{ data: string; id: string | null }> {
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream") ||
    !response.body
  )
    throw failure("Expected a server-sent event stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "",
    lines: string[] = [],
    id: string | null = null,
    frameSize = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > 4_194_304) throw failure("SSE frame exceeds limit");
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line) {
          if (lines.length) yield { data: lines.join("\n"), id };
          lines = [];
          id = null;
          frameSize = 0;
        } else if (line.startsWith("data:")) {
          frameSize += line.length;
          if (frameSize > 4_194_304) throw failure("SSE frame exceeds limit");
          lines.push(line.slice(5).replace(/^ /, ""));
        } else if (line.startsWith("id:")) id = line.slice(3).trim();
        end = buffer.indexOf("\n");
      }
      if (chunk.done) {
        if (buffer.trim() || lines.length) throw failure("Truncated SSE frame");
        break;
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ProviderError) throw error;
    throw failure("Provider stream disconnected; no automatic replay");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function parse(data: string): Json {
  try {
    return object(JSON.parse(data));
  } catch {
    throw failure("Malformed protocol JSON");
  }
}
export function assertRequest(
  request: ModelRequest,
  config: ProviderConfig,
): void {
  request.signal.throwIfAborted();
  if (!request.modelId.trim()) throw failure("Model ID is required");
  const native = request.nativeContext;
  if (
    native &&
    (native.providerId !== config.id ||
      native.providerRevision !== config.revision ||
      native.protocol !== config.protocol ||
      native.modelId !== request.modelId)
  )
    throw failure("Private context belongs to another Provider or model");
  if (
    request.messages.some((m) => m.role === "tool" && m.result.images?.length)
  )
    throw failure("Image tool results are not enabled by this adapter");
}
