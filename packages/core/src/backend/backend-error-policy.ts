/**
 * Backend inference error classification + bounded retry (gap 1, 2026-06-20).
 *
 * The backend turn loop's provider call used to turn ANY error into a flat
 * `turn.failed` — a transient SSE drop or a 429 killed the whole `@板砖`
 * invocation. This maps each failure to a NAMED reason with a retry decision
 * and bounds the retry loop deterministically (D4: safety/robustness is harness
 * code, never persona prose).
 *
 * Three independent bounds (Hermes's design, ported):
 *   - per-reason one-shot "free" retry — each distinct reason gets exactly one
 *     retry that does NOT count against the hard cap, so a fix that doesn't fix
 *     can't spin (the boolean is the termination proof);
 *   - a hard retry cap (MAX_HARD_RETRIES) on everything past the free retries;
 *   - a turn iteration cap (MAX_TURN_ITERATIONS) on the outer tool-loop.
 *
 * Provider-patterns-first: a 4xx (content-filter / auth / bad request) is
 * classified terminal from its code+status and is NEVER downgraded to a
 * retryable "transient" error — even if the provider's `retryable` flag says
 * otherwise. The flag is consulted only as a last resort for an ambiguous http
 * error with no status.
 *
 * Core must not depend on `@herta/providers`, so the thrown `ProviderError` is
 * matched structurally (duck-typed) rather than by `instanceof`.
 */

/** Max retries past the per-reason free retries, per provider call. */
export const MAX_HARD_RETRIES = 3;

/** Outer tool-loop iteration cap per backend turn (a runaway-loop backstop;
 *  set generously so real tasks never hit it). */
export const MAX_TURN_ITERATIONS = 100;

/** Largest single backoff, so exponential growth can't park a retry for minutes. */
export const MAX_BACKOFF_MS = 30_000;

export type BackendErrorReason =
  | "rate-limited"
  | "server-error"
  | "stream-dropped"
  | "network"
  | "stall"
  | "bad-request"
  | "missing-key"
  | "malformed-tool-args"
  | "unknown";

export interface BackendErrorClass {
  readonly reason: BackendErrorReason;
  readonly retryable: boolean;
  /** Base backoff (ms) before the first retry of this reason; 0 when terminal. */
  readonly baseBackoffMs: number;
}

/** Structural match for `@herta/providers`'s ProviderError without importing it
 *  (would invert the core→providers dependency). */
interface ProviderErrorLike {
  readonly name: string;
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
}

function isProviderErrorLike(err: unknown): err is ProviderErrorLike {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return (
    e.name === "ProviderError" &&
    typeof e.code === "string" &&
    typeof e.retryable === "boolean"
  );
}

const retry = (
  reason: BackendErrorReason,
  baseBackoffMs: number,
): BackendErrorClass => ({ reason, retryable: true, baseBackoffMs });

const terminal = (reason: BackendErrorReason): BackendErrorClass => ({
  reason,
  retryable: false,
  baseBackoffMs: 0,
});

/**
 * Map a thrown inference error to a named reason + retry decision. Abort errors
 * must be filtered by the caller BEFORE this (they are control flow, not
 * failures). A non-ProviderError is treated as terminal `unknown` — never
 * blind-retried.
 */
export function classifyBackendInferenceError(err: unknown): BackendErrorClass {
  if (isProviderErrorLike(err)) {
    switch (err.code) {
      case "sse":
        return retry("stream-dropped", 500);
      case "network":
        return retry("network", 800);
      case "stall": {
        // Named reason (audit 2026-07-10 §6): stalls used to fall through to
        // terminal "unknown", so an exhausted headers-phase stall surfaced
        // as an unexplained failure. The provider's own flag carries the
        // phase semantics (H1 invariant): headers-phase → retryable:true
        // (nothing consumed), body-phase → retryable:false (mid-stream
        // output already consumed — a blind retry would double-speak).
        return err.retryable ? retry("stall", 800) : terminal("stall");
      }
      case "missing-key":
        return terminal("missing-key");
      // Defensive fallback only. The OpenAI-compatible stream no longer
      // THROWS on unparseable tool arguments — it marks the call
      // (`ToolCallRequest.malformedArgs`) and the turn loop answers it with a
      // model-visible result, because killing the brief discarded work the
      // model could have recovered from. Kept terminal for any other provider
      // that still raises it: never blind-retry a call we could not read.
      case "tool-args":
        return terminal("malformed-tool-args");
      case "http": {
        const status = err.status;
        if (status === 429) return retry("rate-limited", 2000);
        if (status !== undefined && status >= 500) {
          return retry("server-error", 800);
        }
        if (status !== undefined && status >= 400) {
          // 4xx (content-filter / auth / not-found): never retry, regardless of
          // the provider's retryable flag — provider-patterns win.
          return terminal("bad-request");
        }
        // No status: trust the provider's own retryable flag as a last resort.
        return err.retryable
          ? retry("server-error", 800)
          : terminal("bad-request");
      }
      default:
        return terminal("unknown");
    }
  }
  return terminal("unknown");
}

export type RetryDecision =
  | { readonly kind: "retry"; readonly backoffMs: number }
  | { readonly kind: "surface"; readonly detail: string };

/**
 * Per-provider-call retry budget. Construct a fresh one for each new inference
 * call; it tracks which reasons have spent their free retry and the shared hard
 * cap. Jitter keeps concurrent sessions off lockstep; inject `random` for tests.
 */
export class BackendRetryState {
  private readonly firedReasons = new Set<BackendErrorReason>();
  private hardRetries = 0;
  private attempts = 0;

  constructor(private readonly random: () => number = Math.random) {}

  /** Decide whether to retry the failed call or surface it. Advances the budget. */
  decide(cls: BackendErrorClass): RetryDecision {
    if (!cls.retryable) return { kind: "surface", detail: "not retryable" };

    if (this.firedReasons.has(cls.reason)) {
      this.hardRetries += 1;
      if (this.hardRetries > MAX_HARD_RETRIES) {
        return {
          kind: "surface",
          detail: `exhausted ${MAX_HARD_RETRIES} retries`,
        };
      }
    } else {
      // First time for this reason → a free retry (does not spend the hard cap).
      this.firedReasons.add(cls.reason);
    }

    this.attempts += 1;
    const exp = Math.min(
      cls.baseBackoffMs * 2 ** (this.attempts - 1),
      MAX_BACKOFF_MS,
    );
    const backoffMs = Math.round(exp * (0.5 + this.random() * 0.5));
    return { kind: "retry", backoffMs };
  }
}
