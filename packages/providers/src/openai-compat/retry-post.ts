import { ProviderError } from "../errors.js";
import { isTlsOrProxyFailure, providerFetch } from "../transport.js";
import { abortError, isAbortError } from "./abort.js";
import { type ApiKey, resolveApiKey } from "./api-key.js";
import {
  DEFAULT_HEADERS_TIMEOUT_MS,
  fetchWithHeadersDeadline,
  readErrorBodyBounded,
} from "./fetch-deadline.js";

/**
 * The retry/deadline/error-mapping loop shared by the chat endpoint
 * (`http.ts`) and the completion endpoint (`completion-http.ts`). The two
 * callers differ only in URL and wire body; everything below — attempt
 * pacing, the headers-phase stall deadline, TLS/proxy failures thrown not
 * retried (audit S3), bounded error-body reads (audit finding 18), the
 * 429/5xx retry class — was a verbatim twin in both files until 2026-08-19
 * and had to be fixed twice per audit. One loop, two thin callers.
 */
export interface RetryPostOpts {
  url: string;
  apiKey: ApiKey;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** Maximum retry attempts for retryable failures (network / 429 / 5xx).
   * Default: 2. Set to 0 to disable retries. */
  maxRetries?: number;
  /** Base backoff in ms; doubles each attempt with ±25% jitter.
   * Default: 500. */
  retryBaseMs?: number;
  /** Max ms to wait for response HEADERS before treating the attempt as a
   * retryable stall (hang audit 2026-07-09, H1). Applies to the headers
   * phase only — once headers arrive the SSE idle watchdog owns the body.
   * 0 disables. Default 30s. */
  headersTimeoutMs?: number;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 500;

/** POST a JSON body with bearer auth, retrying transient failures. Resolves
 *  with the OK response (body unconsumed); throws a `ProviderError` for a
 *  permanent failure or the last retryable one, and rethrows aborts. */
export async function postJsonWithRetry(
  opts: RetryPostOpts,
  bodyJson: string,
  signal: AbortSignal,
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? providerFetch();
  const headers = new Headers({
    "content-type": "application/json",
    authorization: `Bearer ${resolveApiKey(opts.apiKey)}`,
  });
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) headers.set(k, v);
  }
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const headersTimeoutMs = opts.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;

  let lastError: ProviderError | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      // Honor abort between retries.
      if (signal.aborted) throw abortError();
      await sleep(retryBackoffMs(retryBaseMs, attempt), signal);
    }

    let res: Response;
    try {
      res = await fetchWithHeadersDeadline(
        fetchImpl,
        opts.url,
        { method: "POST", headers, body: bodyJson, signal },
        headersTimeoutMs,
      );
    } catch (cause) {
      if (isAbortError(cause)) throw cause;
      // A certificate or proxy failure (audit S3) is thrown, not retried: an
      // intercepting proxy Herta does not trust rejects the second attempt
      // exactly like the first, and the user needs to be told to go fix the
      // machine rather than watch three silent retries end in "please resend".
      if (isTlsOrProxyFailure(cause)) {
        throw new ProviderError({
          code: "network-tls",
          retryable: false,
          message: cause instanceof Error ? cause.message : "TLS failure",
          cause,
        });
      }
      // A headers-phase stall is already a typed retryable ProviderError —
      // keep it as-is so the caller sees "stall", not a generic wrap.
      lastError =
        cause instanceof ProviderError
          ? cause
          : new ProviderError({
              code: "network",
              retryable: true,
              message: cause instanceof Error ? cause.message : "fetch failed",
              cause,
            });
      continue; // retry — network errors / header stalls are typically transient
    }

    if (!res.ok) {
      // Bounded read (audit finding 18): a bare res.text() had no watchdog —
      // a 500 header followed by a stalled body parked forever. Aborts
      // rethrow (they escape the retry loop as interrupts, not HTTP errors).
      const text = await readErrorBodyBounded(res, headersTimeoutMs);
      let detail = res.statusText || "request failed";
      if (text.length > 0) {
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string } };
          if (parsed.error?.message) detail = parsed.error.message;
        } catch {
          detail = text.slice(0, 200);
        }
      }
      const retryable = res.status === 429 || res.status >= 500;
      lastError = new ProviderError({
        code: "http",
        retryable,
        status: res.status,
        message: `${res.status} ${detail}`,
      });
      if (!retryable) throw lastError; // 4xx (except 429) is permanent
      continue; // retry transient HTTP failure
    }

    return res; // success
  }

  // Exhausted retries — throw the last error so the caller sees the most
  // recent failure mode, not the first.
  throw (
    lastError ??
    new ProviderError({
      code: "network",
      retryable: false,
      message: "all retry attempts exhausted",
    })
  );
}

/** Exponential backoff with ±25% jitter. */
function retryBackoffMs(baseMs: number, attempt: number): number {
  const base = baseMs * 2 ** (attempt - 1);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/** Abort-aware sleep. Resolves after `ms`, or rejects with AbortError if
 * the signal aborts during the wait. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
