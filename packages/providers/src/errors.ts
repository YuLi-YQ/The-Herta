export type ProviderErrorCode =
  | "missing-key"
  | "http"
  | "network"
  /** A certificate or proxy failure (audit S3) — an intercepting corporate
   *  proxy Herta's transport does not trust, a misconfigured proxy, an expired
   *  or mismatched certificate. Split out from "network" because the fix is a
   *  machine setting, not a retry: the generic "connection lost, please
   *  resend" sends the user around a loop that can never succeed. Never
   *  retryable. */
  | "network-tls"
  | "sse"
  /** Wall-clock stall: the server accepted the request but stopped sending
   *  bytes (no response headers within the headers deadline, or no SSE bytes
   *  within the idle deadline). Headers-phase stalls are retryable (nothing
   *  was consumed); mid-stream stalls are not (partial output already
   *  yielded). */
  | "stall"
  | "tool-json"
  | "tool-schema"
  | "tool-unknown"
  | "tool-limit"
  | "tool-identity"
  | "tool-truncated"
  | "tool-args";

export interface ProviderErrorInit {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(init: ProviderErrorInit) {
    super(
      init.message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = "ProviderError";
    this.code = init.code;
    this.retryable = init.retryable;
    if (init.status !== undefined) this.status = init.status;
  }
}
