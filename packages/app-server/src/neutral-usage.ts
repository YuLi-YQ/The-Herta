import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelEvent, ProviderProtocol } from "@herta/providers";
import type { RoundMetrics } from "./round-summary.js";

const writes = new Map<string, Promise<void>>();
type Usage = Extract<ModelEvent, { type: "usage" }>;
interface Scope {
  sessionId: string;
  turnId: string;
  protocol: ProviderProtocol;
  modelId: string;
  role: "persona" | "executor";
  providerId?: string;
  providerRevision?: number;
  baseURL?: string;
}
interface Entry extends Omit<Scope, "baseURL"> {
  schemaVersion: 2;
  requestId: string;
  supported: boolean;
  at: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheHitInputTokens: number | null;
  durationMs: number | null;
}
const number = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
function supported(baseURL?: string): boolean {
  try {
    const u = new URL(baseURL ?? "");
    return (
      u.protocol === "https:" &&
      u.hostname === "api.deepseek.com" &&
      (!u.port || u.port === "443") &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
function append(path: string | undefined, entry: unknown): Promise<void> {
  if (!path) return Promise.resolve();
  const line = `${JSON.stringify(entry)}\n`;
  const next = (writes.get(path) ?? Promise.resolve())
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, line, "utf8");
    })
    .catch(() => {});
  writes.set(path, next);
  return next;
}
/** One tracker per actual stream call. Cumulative usage replaces, never adds. */
export function beginNeutralUsage(path: string | undefined, scope: Scope) {
  const { baseURL, ...identity } = scope;
  const entry: Entry = {
    ...identity,
    schemaVersion: 2,
    requestId: randomUUID(),
    supported: supported(baseURL),
    at: new Date().toISOString(),
    inputTokens: null,
    outputTokens: null,
    cacheHitInputTokens: null,
    durationMs: null,
  };
  let done = false;
  // A start marker makes interrupted/crashed requests explicitly incomplete.
  void append(path, entry);
  return {
    requestId: entry.requestId,
    record(event: Usage) {
      if (done) return;
      entry.inputTokens = number(event.inputTokens);
      entry.outputTokens = number(event.outputTokens);
      entry.cacheHitInputTokens = number(event.cacheHitInputTokens);
    },
    finish(): Promise<void> {
      if (done) return writes.get(path ?? "") ?? Promise.resolve();
      done = true;
      return append(path, entry);
    },
  };
}
/** Compatibility for old callers; these lack request identity and remain incomplete. */
export function recordNeutralUsage(
  path: string | undefined,
  scope: Scope,
  event: Usage,
): void {
  void append(path, {
    at: new Date().toISOString(),
    ...scope,
    baseURL: undefined,
    prompt: event.inputTokens,
    completion: event.outputTokens,
  });
}
export async function readNeutralMetrics(
  path: string | undefined,
  sessionId: string,
  attemptIds?: readonly string[],
): Promise<RoundMetrics> {
  const empty: RoundMetrics = {
    totalTokens: null,
    cacheHitRate: null,
    outputTokensPerSecond: null,
    contextUsed: null,
    contextWindow: null,
    partial: true,
  };
  if (!path) return empty;
  await writes.get(path);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return empty;
  }
  const entries = new Map<string, Entry>();
  let legacy = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Entry;
      if (
        e.sessionId !== sessionId ||
        (attemptIds && !attemptIds.includes(e.turnId))
      )
        continue;
      if (e.schemaVersion !== 2 || typeof e.requestId !== "string") {
        legacy = true;
        continue;
      }
      entries.set(e.requestId, e);
    } catch {
      legacy = true;
    }
  }
  const all = [...entries.values()];
  if (!all.length) return empty;
  const complete =
    !legacy &&
    all.every(
      (e) =>
        e.supported &&
        number(e.inputTokens) !== null &&
        number(e.outputTokens) !== null,
    );
  const input = all.reduce((n, e) => n + (number(e.inputTokens) ?? 0), 0);
  const total = all.reduce(
    (n, e) => n + (number(e.inputTokens) ?? 0) + (number(e.outputTokens) ?? 0),
    0,
  );
  const cacheComplete =
    complete &&
    input > 0 &&
    all.every(
      (e) =>
        number(e.cacheHitInputTokens) !== null &&
        e.cacheHitInputTokens! <= e.inputTokens!,
    );
  const latest = all.filter((e) => e.role === "persona").at(-1);
  return {
    ...empty,
    totalTokens: complete && Number.isSafeInteger(total) ? total : null,
    cacheHitRate: cacheComplete
      ? all.reduce((n, e) => n + e.cacheHitInputTokens!, 0) / input
      : null,
    contextUsed: latest?.supported ? number(latest.inputTokens) : null,
    partial: !complete,
  };
}
