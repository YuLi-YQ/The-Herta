import { createHash } from "node:crypto";
import type { ToolCallRequest } from "@herta/core";
import type {
  ModelRequest,
  NativeContext,
  NeutralMessage,
  ProviderConfig,
} from "../contracts.js";
import type { MessageImage } from "../images.js";
import { failure, object } from "./common.js";

interface NativeTurn {
  index: number;
  historyHash: string;
  assistantHash: string;
  wire: unknown;
}
interface Opaque {
  version: 1;
  turns: NativeTurn[];
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}
function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
/** A picture enters a history fingerprint as the digest of its bytes, worked out once per picture
 *  object (F02): an executor run carries its pictures on every step and checks every earlier step's
 *  history again each time, which hashed the same megabytes over and over on the main thread. The
 *  digest still covers the content, and base64 has no ":", so a digest never passes for data. */
const pictureDigests = new WeakMap<
  MessageImage,
  { readonly data: string; readonly digest: string }
>();
function pictureDigest(image: MessageImage): MessageImage {
  let known = pictureDigests.get(image);
  if (known?.data !== image.data) {
    known = {
      data: image.data,
      digest: `sha256:${createHash("sha256").update(image.data).digest("hex")}`,
    };
    pictureDigests.set(image, known);
  }
  return { mimeType: image.mimeType, data: known.digest };
}
function history(messages: readonly NeutralMessage[]): NeutralMessage[] {
  return messages.map((m) =>
    m.role === "user" && m.images?.length
      ? { ...m, images: m.images.map(pictureDigest) }
      : m,
  );
}
function turns(request: ModelRequest): NativeTurn[] {
  if (!request.nativeContext) return [];
  const opaque = object(request.nativeContext.opaque);
  if (opaque.version !== 1 || !Array.isArray(opaque.turns))
    throw failure("Unknown private protocol context format");
  return opaque.turns.map((raw) => {
    const turn = object(raw);
    if (
      !Number.isInteger(turn.index) ||
      typeof turn.index !== "number" ||
      turn.index < 0 ||
      typeof turn.historyHash !== "string" ||
      typeof turn.assistantHash !== "string"
    )
      throw failure("Invalid private protocol context");
    return {
      index: turn.index,
      historyHash: turn.historyHash,
      assistantHash: turn.assistantHash,
      wire: turn.wire,
    };
  });
}
/** Only a matching, unchanged neutral transcript may reuse each private output. */
export function nativeOverrides(request: ModelRequest): Map<number, unknown> {
  const out = new Map<number, unknown>();
  for (const turn of turns(request)) {
    if (
      request.messages[turn.index]?.role !== "assistant" ||
      hash(history(request.messages.slice(0, turn.index))) !==
        turn.historyHash ||
      hash(request.messages[turn.index]) !== turn.assistantHash
    )
      throw failure("Private context does not match this transcript");
    if (out.has(turn.index)) throw failure("Duplicate private context entry");
    out.set(turn.index, turn.wire);
  }
  return out;
}
export function completedNative(
  config: ProviderConfig,
  request: ModelRequest,
  text: string,
  calls: ToolCallRequest[],
  wire: unknown,
): NativeContext {
  nativeOverrides(request);
  const prior = turns(request);
  const next: NativeTurn = {
    index: request.messages.length,
    historyHash: hash(history(request.messages)),
    assistantHash: hash({ role: "assistant", text, toolCalls: calls }),
    wire,
  };
  const opaque: Opaque = { version: 1, turns: [...prior, next] };
  return {
    providerId: config.id,
    providerRevision: config.revision,
    protocol: config.protocol,
    modelId: request.modelId,
    opaque,
  };
}
