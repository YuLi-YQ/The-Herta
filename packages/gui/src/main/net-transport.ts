import { setProviderFetch } from "@herta/providers";
import { net } from "electron";

/**
 * Route every provider request through Chromium instead of Node (audit S3).
 *
 * `net.fetch` resolves proxies the way the rest of the OS does — system
 * settings, PAC scripts, WPAD, `HTTPS_PROXY` — and validates certificates
 * against the Windows/macOS trust store, which is where a corporate root CA
 * actually lives. Node's `globalThis.fetch` does neither, so on a managed
 * laptop the DeepSeek call fails at TLS, becomes a generic
 * `ProviderError{code:"network"}`, and surfaces as "connection lost — please
 * resend" forever. There is no proxy field and no CA option in the UI to
 * escape that with, which is what made it a shipping problem rather than a
 * configuration one.
 *
 * The app already trusted this stack: the voice protocol handler has used
 * `net.fetch` since it was written.
 *
 * Must be called inside `whenReady` — `net.fetch` needs the default session,
 * which does not exist before the app is ready.
 */
export function installChromiumFetch(): void {
  setProviderFetch(chromiumFetch);
}

/** `net.fetch` narrowed to the `fetch` shape. It accepts a string or a
 *  `Request` but not a `URL`, and its `Response` is the same global class the
 *  callers already read SSE bodies from. */
const chromiumFetch: typeof fetch = (input, init) => {
  const target =
    typeof input === "string" || input instanceof Request
      ? input
      : String(input);
  return net.fetch(target, init);
};
