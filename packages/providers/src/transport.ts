/**
 * The fetch every provider request goes through (audit S3).
 *
 * Node's `globalThis.fetch` is undici: it reads neither the OS proxy
 * configuration nor `HTTPS_PROXY`, and it validates certificates against
 * Node's own bundled Mozilla root list rather than the Windows/macOS trust
 * store where a corporate root CA is installed. On a managed laptop running
 * Zscaler/Netskope — where TLS is intercepted and re-signed by a root the OS
 * trusts and Node does not — every other Electron app works and Herta looks
 * permanently broken, with no proxy field and no CA option anywhere in the UI.
 *
 * So the transport is a process-wide injection point rather than a per-call
 * parameter: the Electron main process installs Chromium's `net.fetch` once at
 * startup (see gui/src/main/net-transport.ts) and every provider — actor,
 * backend, router, supervisor, title, key validation — inherits it. Threading
 * a `fetchImpl` through AppServerConfig into the nine construction sites would
 * have produced nine chances to miss one.
 *
 * An explicit `opts.fetchImpl` still wins, so the test suite's fixture fetches
 * are unaffected by whatever is installed.
 */

let installed: typeof fetch | undefined;

/** Install the process-wide provider transport. `undefined` restores the
 *  platform default. Call once, before any provider is constructed. */
export function setProviderFetch(impl: typeof fetch | undefined): void {
  installed = impl;
}

/** The transport to use when a call site supplies no `fetchImpl`. */
export function providerFetch(): typeof fetch {
  return installed ?? globalThis.fetch;
}

/**
 * Certificate and proxy failures, told apart from ordinary DNS/connect ones.
 *
 * The distinction is not cosmetic: "connection lost — please resend" invites a
 * retry, and a retry across an untrusted intercepting proxy fails identically
 * forever. These are the cases where the fix is a machine configuration the
 * user has to go change, so they get their own message and are not retried.
 *
 * Both vocabularies appear because both stacks are reachable: Chromium's
 * `net::ERR_*` once `net.fetch` is installed, Node's OpenSSL codes on a CLI
 * build (and on any path that still falls through to undici).
 */
const TLS_SIGNALS: readonly string[] = [
  // Chromium (net.fetch)
  "ERR_CERT_",
  "ERR_SSL_",
  "ERR_TLS_",
  "ERR_PROXY_",
  "ERR_MANDATORY_PROXY_CONFIGURATION_FAILED",
  "ERR_TUNNEL_CONNECTION_FAILED",
  // Node / OpenSSL (undici)
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_UNTRUSTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
];

/** True when the failure is a certificate or proxy problem — i.e. one that
 *  retrying cannot fix and that names a machine-configuration cause. Walks the
 *  `cause` chain because undici buries the OpenSSL code one or two levels
 *  under a bare "fetch failed". */
export function isTlsOrProxyFailure(err: unknown): boolean {
  for (let cur = err, depth = 0; cur !== undefined && depth < 6; depth += 1) {
    if (cur instanceof Error) {
      const code = (cur as { code?: unknown }).code;
      const text = `${typeof code === "string" ? code : ""} ${cur.message}`;
      if (TLS_SIGNALS.some((s) => text.includes(s))) return true;
      cur = (cur as { cause?: unknown }).cause;
      continue;
    }
    return false;
  }
  return false;
}
