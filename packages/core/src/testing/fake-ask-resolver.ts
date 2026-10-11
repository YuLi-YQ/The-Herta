import type { AskResolver } from "../permission-engine.js";
import type { PermissionRequest } from "../types/events.js";

interface Pending {
  request: PermissionRequest;
  resolve: (d: "allow" | "deny") => void;
  reject: (err: unknown) => void;
}

export class FakeAskResolver implements AskResolver {
  readonly pending: Pending[] = [];

  async present(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<"allow" | "deny"> {
    return new Promise<"allow" | "deny">((resolve, reject) => {
      const entry: Pending = { request, resolve, reject };
      this.pending.push(entry);
      const onAbort = () => reject(signal.reason ?? new Error("abort"));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  allow(idx = 0): void {
    this.entry(idx).resolve("allow");
  }

  deny(idx = 0): void {
    this.entry(idx).resolve("deny");
  }

  fail(err: unknown, idx = 0): void {
    this.entry(idx).reject(err);
  }

  private entry(idx: number): Pending {
    const e = this.pending[idx];
    if (!e)
      throw new Error(`FakeAskResolver: no pending entry at index ${idx}`);
    return e;
  }
}
