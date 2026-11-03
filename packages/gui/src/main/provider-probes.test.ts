// @vitest-environment node
import { mkdtempSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { imageSupport } from "@herta/providers/images";
import type { ProtocolAdapter, ProviderProtocol } from "@herta/providers";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => state.root },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (s: string) => Buffer.from(s).map((b) => b ^ 85),
    decryptString: (b: Buffer) => Buffer.from(b.map((v) => v ^ 85)).toString(),
  },
}));
vi.mock("@herta/providers", () => ({
  createProtocolAdapter: () => {
    throw new Error("Inject deterministic adapter in tests");
  },
}));

import {
  discoverProviderModels,
  validateProviderModel,
} from "./provider-probes.js";
import { PROBE_PALETTE } from "./probe-image.js";
import {
  acquireTurnProviders,
  deleteProvider,
  getProviderSettings,
  resolveProviderCredential,
  saveProvider,
  setProviderBindings,
} from "./provider-settings.js";

const create = (protocol: ProviderProtocol = "openai-responses") =>
  saveProvider({
    name: "probe",
    protocol,
    baseURL: "https://example.invalid/prefix/v1",
    authentication: "api-key",
    allowRemoteHTTP: false,
    models: [{ id: "manual" }],
    defaults: { model: "manual", timeoutMs: 2000 },
    credential: { action: "replace", value: "synthetic-secret" },
  }).settings.providers[0]!;
const adapter = (extra: Partial<ProtocolAdapter> = {}): ProtocolAdapter => ({
  protocol: "openai-responses",
  async *stream() {
    yield { type: "text-delta", text: "HERTA_OK" };
    yield { type: "finished", reason: "stop" };
  },
  async listModels() {
    return { models: [], nextCursor: null };
  },
  ...extra,
});
beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "herta-r3-probes-"));
});
it("real loopback model discovery drops malformed optional aliases and leaves the on-disk configuration readable", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        data: [
          { id: "newline-model", display_name: "Model\nName" },
          { id: "blank-model", display_name: "   " },
          { id: "null-model", display_name: "Model\0Name" },
          { id: "large-model", display_name: "x".repeat(257) },
          { id: "valid-model", display_name: "  Valid Name  " },
        ],
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const p = saveProvider({
      name: "actual socket metadata fixture",
      protocol: "openai-responses",
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/prefix/v1`,
      authentication: "none",
      allowRemoteHTTP: false,
      models: [{ id: "manual" }],
      defaults: { model: "manual", timeoutMs: 2000 },
      credential: { action: "clear" },
    }).settings.providers[0]!;
    const real =
      await vi.importActual<typeof import("@herta/providers")>(
        "@herta/providers",
      );
    const result = await discoverProviderModels(
      { providerId: p.id, expectedRevision: p.revision, refresh: true },
      (config, key) => real.createProtocolAdapter(config, key, { fetch }),
    );
    expect(result.diagnostic).toBeUndefined();
    expect(result.models.map((m) => m.id)).toEqual([
      "newline-model",
      "blank-model",
      "null-model",
      "large-model",
      "valid-model",
    ]);
    expect(result.models.slice(0, 4).every((m) => m.alias === undefined)).toBe(
      true,
    );
    expect(result.models[4]?.alias).toBe("Valid Name");
    const reread = getProviderSettings();
    expect(reread.settings.providers[0]?.models.map((m) => m.id)).toEqual([
      "manual",
      ...result.models.map((m) => m.id),
    ]);
    expect(reread.settings.providers[0]?.models.at(-1)?.alias).toBe(
      "Valid Name",
    );
    expect(reread.settings.providers[0]?.models[0]?.validation.state).toBe(
      "unverified",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
});
it.each([
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
] as const)("%s discoveries paginate, cache and never infer model capabilities", async (protocol) => {
  const p = create(protocol);
  const list = vi.fn(async ({ cursor }: { cursor?: string }) =>
    cursor
      ? { models: [{ id: "b" }], nextCursor: null }
      : { models: [{ id: "a" }], nextCursor: "next" },
  );
  const factory = () => adapter({ protocol, listModels: list });
  const input = { providerId: p.id, expectedRevision: p.revision };
  const result = await discoverProviderModels(input, factory);
  expect(list).toHaveBeenCalledTimes(2);
  expect(result.models.map((m) => m.id)).toEqual(["a", "b"]);
  expect(result.view.settings.providers[0]!.models.map((m) => m.id)).toEqual([
    "manual",
    "a",
    "b",
  ]);
  expect(result.view.settings.providers[0]!.models[1]!.capabilities.tools).toBe(
    "unknown",
  );
  expect((await discoverProviderModels(input, factory)).cached).toBe(true);
  expect(list).toHaveBeenCalledTimes(2);
});
it.each([
  403, 404,
])("list %s preserves manual models and returns safe diagnostic", async (status) => {
  const p = create();
  const result = await discoverProviderModels(
    { providerId: p.id, expectedRevision: 1 },
    () =>
      adapter({
        async listModels() {
          throw Object.assign(new Error("synthetic-secret"), { status });
        },
      }),
  );
  expect(result.models).toEqual([{ id: "manual" }]);
  expect(result.diagnostic).not.toContain("synthetic-secret");
  expect(result.view.settings.providers[0]!.models[0]!.validation.state).toBe(
    "unverified",
  );
});
it("repeated cursor and partial list do not overwrite manual models", async () => {
  const p = create();
  const result = await discoverProviderModels(
    { providerId: p.id, expectedRevision: 1 },
    () =>
      adapter({
        async listModels() {
          return { models: [{ id: "discovered" }], nextCursor: "same" };
        },
      }),
  );
  expect(result.diagnostic).toBeTruthy();
  expect(getProviderSettings().settings.providers[0]!.models).toHaveLength(1);
});
it("text probe does not certify tools; tool probe validates nonce/schema and full completion", async () => {
  const p = create();
  const input = { providerId: p.id, modelId: "manual", expectedRevision: 1 };
  expect(
    (await validateProviderModel({ ...input, kind: "text" }, () => adapter()))
      .validation.state,
  ).toBe("text-available");
  expect(
    getProviderSettings().settings.providers[0]!.models[0]!.capabilities.tools,
  ).toBe("unknown");
  const result = await validateProviderModel({ ...input, kind: "tools" }, () =>
    adapter({
      async *stream(request) {
        const schema = request.tools[0]!.inputSchema as {
          properties: { nonce: { enum: string[] } };
        };
        yield {
          type: "tool-call-ready",
          call: {
            id: "call1",
            tool: "herta_probe",
            input: { nonce: schema.properties.nonce.enum[0] },
          },
        };
        yield { type: "finished", reason: "tool-calls" };
      },
    }),
  );
  expect(result.validation.state).toBe("tools-available");
  expect(result.view.settings.providers[0]!.models[0]!.capabilities.tools).toBe(
    "supported",
  );
});
it.each([
  "truncated",
  "wrong-nonce",
  "duplicate",
  "only-deltas",
])("tool probe %s cannot certify execution", async (mode) => {
  const p = create();
  const result = await validateProviderModel(
    { providerId: p.id, modelId: "manual", expectedRevision: 1, kind: "tools" },
    () =>
      adapter({
        async *stream(request) {
          const nonce = (
            request.tools[0]!.inputSchema as {
              properties: { nonce: { enum: string[] } };
            }
          ).properties.nonce.enum[0];
          const call = {
            id: "call",
            tool: "herta_probe",
            input: { nonce: mode === "wrong-nonce" ? "bad" : nonce },
          };
          if (mode === "only-deltas")
            yield {
              type: "tool-arguments-delta",
              callId: "call",
              tool: "herta_probe",
              delta: "{}",
            };
          else yield { type: "tool-call-ready", call };
          if (mode === "duplicate") yield { type: "tool-call-ready", call };
          if (mode !== "truncated")
            yield { type: "finished", reason: "tool-calls" };
        },
      }),
  );
  expect(result.validation.state).toBe(mode === "truncated" ? "unverified" : "failed");
  expect(result.view.settings.providers[0]!.models[0]!.capabilities.tools).toBe(
    "unknown",
  );
});
it("concurrent config edits invalidate an old result", async () => {
  const p = create();
  await expect(
    validateProviderModel(
      {
        providerId: p.id,
        modelId: "manual",
        expectedRevision: 1,
        kind: "text",
      },
      () =>
        adapter({
          async *stream() {
            saveProvider({
              id: p.id,
              expectedRevision: 1,
              name: "changed",
              protocol: p.protocol,
              baseURL: p.baseURL,
              authentication: p.authentication,
              allowRemoteHTTP: false,
              models: [{ id: "manual" }],
              defaults: p.defaults,
              credential: { action: "keep" },
            });
            yield { type: "text-delta", text: "ok" };
            yield { type: "finished", reason: "stop" };
          },
        }),
    ),
  ).rejects.toThrow("配置已改变");
  expect(
    getProviderSettings().settings.providers[0]!.models[0]!.validation.state,
  ).toBe("unverified");
});
it("frozen turn keeps old key/config, disallows active deletion and release is idempotent", async () => {
  const p = create();
  await validateProviderModel(
    { providerId: p.id, modelId: "manual", expectedRevision: 1, kind: "tools" },
    () =>
      adapter({
        async *stream(r) {
          yield {
            type: "tool-call-ready",
            call: {
              id: "x",
              tool: "herta_probe",
              input: {
                nonce: (
                  r.tools[0]!.inputSchema as {
                    properties: { nonce: { enum: string[] } };
                  }
                ).properties.nonce.enum[0],
              },
            },
          };
          yield { type: "finished", reason: "tool-calls" };
        },
      }),
  );
  setProviderBindings({
    bindings: {
      persona: { providerId: p.id, modelId: "manual" },
      executor: { providerId: p.id, modelId: "manual" },
    },
  });
  const lease = acquireTurnProviders("session", "turn");
  expect(Object.isFrozen(lease.snapshot.persona.defaults)).toBe(true);
  expect(lease.executorKey).toBe("synthetic-secret");
  expect(() => deleteProvider(p.id)).toThrow("先停止");
  const edited = saveProvider({
    id: p.id,
    expectedRevision: 1,
    name: "changed",
    protocol: p.protocol,
    baseURL: p.baseURL,
    authentication: "api-key",
    allowRemoteHTTP: false,
    models: [{ id: "manual" }],
    defaults: p.defaults,
    credential: { action: "replace", value: "new-synthetic" },
  }).settings.providers[0]!;
  expect(lease.snapshot.executor.revision).toBe(1);
  expect(lease.executorKey).toBe("synthetic-secret");
  expect(resolveProviderCredential(edited)).toBe("new-synthetic");
  lease.release();
  lease.release();
  expect(deleteProvider(p.id).settings.providers).toHaveLength(0);
  expect(readdirSync(join(state.root, "provider-credentials"))).toHaveLength(0);
});
it("unknown executor tools fail before acquiring a turn", async () => {
  const p = create();
  setProviderBindings({
    bindings: {
      persona: { providerId: p.id, modelId: "manual" },
      executor: { providerId: p.id, modelId: "manual" },
    },
  });
  await validateProviderModel(
    {
      providerId: p.id,
      expectedRevision: p.revision,
      modelId: "manual",
      kind: "text",
    },
    () => adapter(),
  );
  expect(() => acquireTurnProviders("s", "t")).toThrow("工具能力验证");
  expect(deleteProvider(p.id).settings.providers).toHaveLength(0);
});

/** Read the probe picture back the way a model would have to: decode its pixels and name the
 *  colour of each square from the palette (the generator writes one IDAT, filter 0 rows). */
function readProbePicture(base64: string): string[] {
  const png = Buffer.from(base64, "base64");
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  const width = png.readUInt32BE(16);
  const chunks: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT")
      chunks.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const at = (x: number, y: number) => {
    const i = y * (width * 3 + 1) + 1 + x * 3;
    const rgb = [raw[i], raw[i + 1], raw[i + 2]];
    return Object.entries(PROBE_PALETTE).find(([, c]) =>
      c.every((v, k) => v === rgb[k]),
    )![0];
  };
  const q = width / 4;
  return [at(q, q), at(3 * q, q), at(q, 3 * q), at(3 * q, 3 * q)];
}

it("image probe sends a generated picture and admits images only when its colours come back (R77)", async () => {
  const p = create("openai-chat-completions");
  const input = { providerId: p.id, expectedRevision: p.revision, modelId: "manual" };
  await validateProviderModel({ ...input, kind: "text" }, () => adapter());
  let seen: { images: number; mime?: string; supportedForProbe?: string } = { images: 0 };
  const result = await validateProviderModel({ ...input, kind: "images" }, (config) =>
    adapter({
      async *stream(request) {
        const user = request.messages[0];
        const images = user?.role === "user" ? (user.images ?? []) : [];
        seen = {
          images: images.length,
          mime: images[0]?.mimeType,
          supportedForProbe: config.models.find((m) => m.id === "manual")
            ?.capabilities.images,
        };
        yield { type: "text-delta", text: `${readProbePicture(images[0]!.data).join(" ")}.` };
        yield { type: "finished", reason: "stop" };
      },
    }),
  );
  expect(seen).toEqual({ images: 1, mime: "image/png", supportedForProbe: "supported" });
  expect(result.images).toEqual({ supported: true });
  const model = result.view.settings.providers[0]!.models[0]!;
  expect(model.capabilities.images).toBe("supported");
  // The text validation is the text probe's, untouched by the image probe.
  expect(model.validation.state).toBe("text-available");
  expect(
    imageSupport(result.view.settings.providers[0]!, "manual"),
  ).toBe(true);
});

it("a wrong colour reading or a refused request leaves images unsupported (R77)", async () => {
  const p = create("openai-chat-completions");
  const input = { providerId: p.id, expectedRevision: p.revision, modelId: "manual" };
  // Pinned: the picture is red, green / blue, yellow, and the reply swaps the top two.
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  const guess = await validateProviderModel({ ...input, kind: "images" }, () =>
    adapter({
      async *stream(request) {
        const user = request.messages[0];
        expect(user?.role === "user" && readProbePicture(user.images![0]!.data)).toEqual(
          ["red", "green", "blue", "yellow"],
        );
        yield { type: "text-delta", text: "green red blue yellow" };
        yield { type: "finished", reason: "stop" };
      },
    }),
  );
  random.mockRestore();
  expect(guess.images?.supported).toBe(false);
  const refused = await validateProviderModel({ ...input, kind: "images" }, () =>
    adapter({
      async *stream() {
        throw Object.assign(new Error("400"), { status: 400 });
      },
    }),
  );
  expect(refused.images?.supported).toBe(false);
  expect(refused.images?.diagnostic).toBeTruthy();
  const model = refused.view.settings.providers[0]!.models[0]!;
  expect(model.capabilities.images).toBe("unsupported");
  expect(model.validation.state).toBe("unverified");
  expect(imageSupport(refused.view.settings.providers[0]!, "manual")).toBe(false);
});

it("text and tool probes never admit images (R77)", async () => {
  const p = create("openai-chat-completions");
  const input = { providerId: p.id, expectedRevision: p.revision, modelId: "manual" };
  await validateProviderModel({ ...input, kind: "text" }, () => adapter());
  const tools = await validateProviderModel({ ...input, kind: "tools" }, () =>
    adapter({
      async *stream(request) {
        const nonce = (request.tools[0]?.inputSchema as { properties: { nonce: { enum: string[] } } }).properties.nonce.enum[0];
        yield { type: "tool-call-ready", call: { id: "c", tool: "herta_probe", input: { nonce } } };
        yield { type: "finished", reason: "tool-calls" };
      },
    }),
  );
  expect(tools.validation.state).toBe("tools-available");
  expect(tools.view.settings.providers[0]!.models[0]!.capabilities.images).toBe("unknown");
  expect(imageSupport(tools.view.settings.providers[0]!, "manual")).toBe(false);
});

// R104 (F06): only an answer from the model, or the server refusing the request, changes a saved
// result; a credential, network, timeout, rate-limit or server failure keeps it.
const toolsAdapter = () =>
  adapter({
    async *stream(request) {
      const nonce = (request.tools[0]?.inputSchema as { properties: { nonce: { enum: string[] } } }).properties.nonce.enum[0];
      yield { type: "tool-call-ready", call: { id: "c", tool: "herta_probe", input: { nonce } } };
      yield { type: "finished", reason: "tool-calls" };
    },
  });
const failing = (error: unknown) =>
  adapter({
    // biome-ignore lint/correctness/useYield: the request fails before any event
    async *stream() {
      throw error;
    },
  });
const timeout = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });

it.each([
  ["network", () => Object.assign(new Error("net"), { code: "network" }), "transient"],
  ["timeout", timeout, "transient"],
  ["rate limit", () => Object.assign(new Error("429"), { code: "http", status: 429 }), "transient"],
  ["server error", () => Object.assign(new Error("503"), { code: "http", status: 503 }), "transient"],
  ["unrecognised", () => new Error("odd"), "transient"],
  ["credential", () => Object.assign(new Error("401"), { code: "http", status: 401 }), "authentication"],
] as const)("a %s failure keeps the saved text/tool result (F06)", async (_name, error, reason) => {
  const p = create();
  const input = { providerId: p.id, modelId: "manual", expectedRevision: 1 };
  await validateProviderModel({ ...input, kind: "text" }, () => adapter());
  const before = await validateProviderModel({ ...input, kind: "tools" }, toolsAdapter);
  expect(before.validation.state).toBe("tools-available");
  for (const kind of ["text", "tools"] as const) {
    const result = await validateProviderModel({ ...input, kind }, () => failing(error()));
    expect(result.kept?.reason).toBe(reason);
    expect(result.kept?.diagnostic).toBeTruthy();
    expect(result.validation).toEqual(before.validation);
  }
  const model = getProviderSettings().settings.providers[0]!.models[0]!;
  expect(model.validation).toEqual(before.validation);
  expect(model.capabilities.tools).toBe("supported");
});

it("a transient failure on an unverified model leaves it unverified, not failed (F06)", async () => {
  const p = create();
  const result = await validateProviderModel(
    { providerId: p.id, modelId: "manual", expectedRevision: 1, kind: "text" },
    () => failing(timeout()),
  );
  expect(result.kept?.reason).toBe("transient");
  expect(result.validation.state).toBe("unverified");
});

it("a refused request or a missing model still fails the text probe (F06)", async () => {
  const p = create();
  const input = { providerId: p.id, modelId: "manual", expectedRevision: 1, kind: "text" as const };
  await validateProviderModel(input, () => adapter());
  for (const status of [400, 404]) {
    const result = await validateProviderModel(input, () =>
      failing(Object.assign(new Error(String(status)), { code: "http", status })),
    );
    expect(result.kept).toBeUndefined();
    expect(result.validation.state).toBe("failed");
    expect(result.validation.diagnostic).not.toContain("请检查连接与服务状态");
  }
});

it("a failed tool probe keeps a current text result instead of failing the model (F06)", async () => {
  const p = create();
  const input = { providerId: p.id, modelId: "manual", expectedRevision: 1 };
  await validateProviderModel({ ...input, kind: "text" }, () => adapter());
  const passed = await validateProviderModel({ ...input, kind: "tools" }, toolsAdapter);
  // The model answers in text instead of calling the tool: a fact about tools, not about text.
  const result = await validateProviderModel({ ...input, kind: "tools" }, () => adapter());
  expect(result.kept).toBeUndefined();
  expect(result.validation.state).toBe("text-available");
  expect(result.validation.checkedAt).toBe(passed.validation.checkedAt);
  // Says what the model did, not "check the connection".
  expect(result.validation.diagnostic).toBe("模型有回复，但没有按要求调用测试工具，工具能力未确认。");
  expect(result.view.settings.providers[0]!.models[0]!.capabilities.tools).toBe("unknown");
  // A refused tool request is the same kind of answer.
  const refused = await validateProviderModel({ ...input, kind: "tools" }, () =>
    failing(Object.assign(new Error("400"), { code: "http", status: 400 })),
  );
  expect(refused.validation.state).toBe("text-available");
  expect(refused.validation.diagnostic).toContain("HTTP 400");
});

it("a transient or credential failure keeps a passed image result (F06)", async () => {
  const p = create("openai-chat-completions");
  const input = { providerId: p.id, expectedRevision: p.revision, modelId: "manual", kind: "images" as const };
  await validateProviderModel(input, () =>
    adapter({
      async *stream(request) {
        const user = request.messages[0];
        const images = user?.role === "user" ? (user.images ?? []) : [];
        yield { type: "text-delta", text: readProbePicture(images[0]!.data).join(" ") };
        yield { type: "finished", reason: "stop" };
      },
    }),
  );
  for (const error of [timeout(), Object.assign(new Error("401"), { code: "http", status: 401 })]) {
    const result = await validateProviderModel(input, () => failing(error));
    expect(result.kept).toBeTruthy();
    expect(result.images).toBeUndefined();
    expect(result.view.settings.providers[0]!.models[0]!.capabilities.images).toBe("supported");
  }
});

it("an older probe that finishes after a newer one does not overwrite it (F06)", async () => {
  const p = create();
  const input = { providerId: p.id, modelId: "manual", expectedRevision: 1, kind: "text" as const };
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  // The first probe is still waiting for its answer when the second one starts and passes.
  const first = validateProviderModel(input, () =>
    adapter({
      async *stream() {
        await gate;
        yield { type: "text-delta", text: "" };
        yield { type: "finished", reason: "stop" };
      },
    }),
  );
  const second = await validateProviderModel(input, () => adapter());
  expect(second.validation.state).toBe("text-available");
  release();
  const late = await first;
  expect(late.superseded).toBe(true);
  expect(late.validation).toEqual(second.validation);
  expect(getProviderSettings().settings.providers[0]!.models[0]!.validation.state).toBe(
    "text-available",
  );
});

it.each(["text", "tools", "images"] as const)("R108 incomplete %s probes preserve prior capabilities", async kind => {
  const p = create();
  const input = { providerId: p.id, modelId: "manual", expectedRevision: p.revision };
  await validateProviderModel({ ...input, kind: "tools" }, toolsAdapter);
  await validateProviderModel({ ...input, kind: "images" }, () => adapter({ async *stream(request) {
    const message = request.messages[0];
    if (message?.role !== "user") throw new Error("fixture");
    yield { type: "text-delta", text: readProbePicture(message.images![0]!.data).join(" ") };
    yield { type: "finished", reason: "stop" };
  } }));
  const before = getProviderSettings().settings.providers[0]!.models[0]!;
  for (const ending of ["missing", "length"] as const) {
    const result = await validateProviderModel({ ...input, kind }, () => adapter({ async *stream() {
      yield { type: "text-delta", text: "partial answer" };
      if (ending === "length") yield { type: "finished", reason: "length" };
    } }));
    expect(result.kept?.reason).toBe("transient");
    expect(result.kept?.diagnostic).toContain("未正常结束");
    expect(getProviderSettings().settings.providers[0]!.models[0]).toEqual(before);
    expect(result.images).toBeUndefined();
  }
});
it("R108 an incomplete first probe does not validate an unknown model", async () => {
  const p = create();
  const result = await validateProviderModel({ providerId: p.id, modelId: "manual", expectedRevision: p.revision, kind: "text" }, () => adapter({ async *stream() {
    yield { type: "finished", reason: "length" };
  } }));
  expect(result.validation.state).toBe("unverified");
  expect(result.kept?.reason).toBe("transient");
});

