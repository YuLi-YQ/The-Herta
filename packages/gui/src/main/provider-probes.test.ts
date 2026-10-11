// @vitest-environment node
import { mkdtempSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  expect(result.validation.state).toBe("failed");
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
