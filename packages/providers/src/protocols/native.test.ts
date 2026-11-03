import { describe, expect, it, vi } from "vitest";
import type {
  ModelRequest,
  NeutralMessage,
  ProviderConfig,
} from "../contracts.js";
import type { MessageImage } from "../images.js";
import { completedNative, nativeOverrides } from "./native.js";

/** Counts hash inputs at least as long as a picture's base64, which only a picture can fill. */
const hashed = vi.hoisted(() => ({
  large: 0,
  threshold: Number.POSITIVE_INFINITY,
}));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createHash: (...args: Parameters<typeof actual.createHash>) => {
      const hash = actual.createHash(...args);
      const update = hash.update.bind(hash);
      hash.update = ((data: string | Buffer, encoding?: BufferEncoding) => {
        if (data.length >= hashed.threshold) hashed.large++;
        return encoding === undefined
          ? update(data)
          : update(data as string, encoding);
      }) as typeof hash.update;
      return hash;
    },
  };
});

const config = {
  id: "executor",
  revision: 4,
  protocol: "openai-chat-completions",
} as ProviderConfig;
const anchor: NeutralMessage = {
  role: "user",
  text: "Execute the current task.",
};
/** 96 KiB of picture: four base64 characters carry three bytes. */
function pictureOf(fill: string): MessageImage {
  return { mimeType: "image/png", data: fill.repeat(32 * 1024) };
}
const row = (image: MessageImage): NeutralMessage => ({
  role: "user",
  text: "[User attachment: picture]\nscreen.png",
  images: [image],
});
function request(
  messages: readonly NeutralMessage[],
  nativeContext?: ModelRequest["nativeContext"],
): ModelRequest {
  return {
    sessionId: "s",
    turnId: "t",
    modelId: "executor-model",
    system: "",
    messages,
    tools: [],
    options: {},
    signal: new AbortController().signal,
    ...(nativeContext ? { nativeContext } : {}),
  };
}
/** One sampling step: the encode check, then the completion's context, as the adapters run them. */
function step(
  messages: readonly NeutralMessage[],
  context: ModelRequest["nativeContext"],
  n: number,
): {
  messages: readonly NeutralMessage[];
  context: ModelRequest["nativeContext"];
} {
  const req = request(messages, context);
  nativeOverrides(req);
  const calls = [
    { id: `c${n}`, tool: "read_file", input: { path: `f${n}.ts` } },
  ];
  const call: NeutralMessage = {
    role: "assistant",
    text: "",
    toolCalls: calls,
  };
  const result: NeutralMessage = {
    role: "tool",
    toolCallId: `c${n}`,
    result: { ok: true, summary: "read" },
  };
  return {
    context: completedNative(config, req, "", calls, { n }),
    messages: [...messages, call, result],
  };
}

describe("private context fingerprints with pictures in the history (F02)", () => {
  it("still matches the same picture, also as a new object, and stops matching when it changes", () => {
    const image = pictureOf("QUJD");
    const first = step([anchor, row(image)], undefined, 1);
    expect(nativeOverrides(request(first.messages, first.context)).size).toBe(
      1,
    );
    // Same bytes in a fresh object and string (read again from disk): the same transcript.
    const copy: MessageImage = {
      mimeType: image.mimeType,
      data: Buffer.from(image.data, "base64").toString("base64"),
    };
    expect(copy.data).toBe(image.data);
    const again = [anchor, row(copy), ...first.messages.slice(2)];
    expect(nativeOverrides(request(again, first.context)).size).toBe(1);
    // Another picture in its place: a different transcript, private output not reused.
    const other = [anchor, row(pictureOf("REVG")), ...first.messages.slice(2)];
    expect(() => nativeOverrides(request(other, first.context))).toThrow(
      "Private context does not match this transcript",
    );
    // The row's words still count.
    const reworded = [
      anchor,
      { ...row(image), text: "[User attachment: picture]\nother.png" },
      ...first.messages.slice(2),
    ];
    expect(() => nativeOverrides(request(reworded, first.context))).toThrow(
      "Private context does not match this transcript",
    );
  });

  it("digests a picture object again when its bytes were replaced", () => {
    const image = pictureOf("QUJD");
    const first = step([anchor, row(image)], undefined, 1);
    image.data = pictureOf("REVG").data;
    expect(() =>
      nativeOverrides(request(first.messages, first.context)),
    ).toThrow("Private context does not match this transcript");
  });

  it("hashes a picture's bytes once over a run of steps, not again for every earlier step", () => {
    const image = pictureOf("QUJD");
    hashed.threshold = image.data.length;
    hashed.large = 0;
    let messages: readonly NeutralMessage[] = [anchor, row(image)];
    let context: ModelRequest["nativeContext"];
    for (let n = 1; n <= 10; n++)
      ({ messages, context } = step(messages, context, n));
    hashed.threshold = Number.POSITIVE_INFINITY;
    expect(hashed.large).toBe(1);
  });
});
