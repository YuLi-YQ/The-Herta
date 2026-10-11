import { ProviderError } from "../errors.js";
import { isAbortError } from "./abort.js";

export const DEFAULT_HEADERS_TIMEOUT_MS = 30_000;

/**
 * `fetch` with a headers-phase deadline (hang audit 2026-07-09, H1). The
 * external `signal` inside `init` stays on the request (so a user interrupt
 * still tears down the connection and the body stream after headers); the
 * deadline is enforced by racing, NOT by an internal AbortController — an
 * internal controller would have to stay linked to the external signal for
 * the whole body lifetime, leaking one abort listener per request (the
 * backend loop runs up to 100 requests per turn signal). On timeout the
 * losing fetch is orphaned safely: a later rejection is marked handled, a
 * later resolution has its body cancelled so the connection slot is not
 * held. At most `maxRetries+1` orphans exist per call, all still tied to
 * the external signal for final reaping.
 *
 * Applies to the headers phase only — once headers arrive, the SSE idle
 * watchdog (`parseSSE`'s `idleTimeoutMs`) owns the body. Throws
 * `ProviderError{code:"stall", retryable:true}` on timeout: nothing has
 * been consumed yet, so the retry loop may safely re-attempt.
 */
export async function fetchWithHeadersDeadline(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (timeoutMs <= 0) return fetchImpl(url, init);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fetchP = fetchImpl(url, init);
  try {
    return await Promise.race([
      fetchP,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ProviderError({
              code: "stall",
              retryable: true,
              message: `no response headers within ${timeoutMs}ms`,
            }),
          );
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    fetchP.then(
      (r) => {
        r.body?.cancel().catch(() => undefined);
      },
      () => undefined,
    );
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a non-OK response's body with a deadline (audit 2026-07-10, finding
 * 18). After the headers deadline settles, a 500 whose BODY stalls parked a
 * bare `res.text()` forever — the headers deadline had already passed and
 * the SSE idle watchdog wraps only the OK path — reopening the H1 hang
 * class. Same racing pattern as fetchWithHeadersDeadline above (no internal
 * AbortController — see its listener-leak rationale). On timeout the
 * stalled body is cancelled and "" returns (the status line alone still
 * makes a useful error). An AbortError raised mid-read RETHROWS — an
 * interrupt is not an HTTP failure (the old `.catch(() => "")` swallowed it
 * and misclassified the interrupt). `timeoutMs <= 0` disables the deadline
 * but keeps the abort rethrow.
 */
export async function readErrorBodyBounded(
  res: Response,
  timeoutMs: number,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const textP = res.text();
    if (timeoutMs <= 0) return await textP.catch(rethrowAbortElseEmpty);
    const result = await Promise.race([
      textP,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]).catch(rethrowAbortElseEmpty);
    if (result === null) {
      // Deadline passed — abandon the stalled read (mark its eventual
      // rejection handled) and cancel the body so the connection slot is
      // not held.
      textP.catch(() => undefined);
      res.body?.cancel().catch(() => undefined);
      return "";
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function rethrowAbortElseEmpty(cause: unknown): "" {
  if (isAbortError(cause)) throw cause;
  return "";
}
