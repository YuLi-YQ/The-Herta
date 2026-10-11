import { providerFetch } from "../transport.js";

/** Result of a key validation check (see `validateDeepSeekKey`). */
export type KeyValidation = "valid" | "rejected" | "unreachable";

export interface ValidateKeyOpts {
  /** Override the API base. Default "https://api.deepseek.com". */
  baseUrl?: string;
  /** Inject a fetch (tests). Default the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Abort the check after this many ms. Default 8000. */
  timeoutMs?: number;
}

/**
 * Validate a DeepSeek API key with a cheap, token-free auth check: a
 * `GET {baseUrl}/models` carrying the key as a Bearer token. DeepSeek answers
 * 200 (with the model list) for a good key and 401/403 for a bad one, so we
 * never spend tokens to find out a key is wrong.
 *
 * Returns:
 *  - `"valid"`      — 2xx, the key authenticates.
 *  - `"rejected"`   — 401/403 (or an empty key), the key is wrong/expired.
 *  - `"unreachable"`— network error, timeout, or any other status (5xx, …): we
 *                     COULD NOT confirm rejection, so the caller should allow the
 *                     save with a soft "couldn't verify" warning rather than
 *                     block an offline user.
 *
 * Main-process / CLI use only — the raw key must not reach the renderer.
 */
export async function validateDeepSeekKey(
  key: string,
  opts: ValidateKeyOpts = {},
): Promise<KeyValidation> {
  const trimmed = key.trim();
  if (trimmed === "") return "rejected";

  const baseUrl = opts.baseUrl ?? "https://api.deepseek.com";
  // The installed transport (audit S3), so key validation goes through the
  // same proxy and trust store as the turns it is validating for — otherwise
  // a managed laptop reports "couldn't verify" for a key that is fine.
  const fetchImpl = opts.fetchImpl ?? providerFetch();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetchImpl(`${baseUrl}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${trimmed}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return "rejected";
    if (res.ok) return "valid";
    // Any other status (5xx, 429, …) is not a definitive rejection.
    return "unreachable";
  } catch {
    // Network failure / timeout / abort — cannot confirm rejection.
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}
