/**
 * An API key that may be a static string OR a getter resolved at request time.
 * The getter form lets a long-lived provider pick up a key changed at runtime
 * (e.g. the GUI's live key store) without being rebuilt.
 */
export type ApiKey = string | (() => string);

/** Resolve an {@link ApiKey} to the current string value. */
export function resolveApiKey(key: ApiKey): string {
  return typeof key === "function" ? key() : key;
}
