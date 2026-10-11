import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveProviderInput } from "../shared/provider-settings-ipc.js";

const state = vi.hoisted(() => ({
  root: "",
  available: true,
  failEncrypt: false,
  failCommit: false,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const renameSync = (from: string, to: string) => {
    if (state.failCommit && to.endsWith("provider-settings.json"))
      throw new Error("commit failed");
    return actual.renameSync(from, to);
  };
  return { ...actual, renameSync, default: { ...actual, renameSync } };
});
vi.mock("electron", () => ({
  app: { getPath: () => state.root },
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (key: string) => {
      if (state.failEncrypt) throw new Error("encryption failed");
      return Buffer.from(key).map((b) => b ^ 0x55);
    },
    decryptString: (buffer: Buffer) =>
      Buffer.from(buffer.map((b) => b ^ 0x55)).toString(),
  },
}));

import {
  deleteProvider,
  getProviderSettings,
  saveProvider,
  setProviderBindings,
  validateProviderURL,
} from "./provider-settings.js";

const input = (extra: Partial<SaveProviderInput> = {}): SaveProviderInput => ({
  name: "我的网关",
  protocol: "openai-responses",
  baseURL: "https://gateway.example/prefix/v1/",
  authentication: "api-key",
  allowRemoteHTTP: false,
  models: [{ id: "custom-model" }],
  defaults: { model: "custom-model", timeoutMs: 60000 },
  credential: { action: "replace", value: "secret-value-alpha" },
  ...extra,
});
describe("R2 Provider persistence (fake encryption unit tests, no API requests)", () => {
  beforeEach(() => {
    state.root = mkdtempSync(join(tmpdir(), "herta-provider-settings-"));
    state.available = true;
    state.failEncrypt = false;
    state.failCommit = false;
  });
  it("persists model effort and rejects unsupported values", () => {
    const view = saveProvider(input({ models: [{ id: "deepseek-flash" }], defaults: { model: "deepseek-flash", timeoutMs: 60000 } }));
    const binding = { providerId: view.settings.providers[0]!.id, modelId: "deepseek-flash", reasoningEffort: "low" };
    setProviderBindings({ sessionId: "task", bindings: { persona: binding, executor: binding } });
    expect(getProviderSettings().settings.sessionBindings.task?.persona.reasoningEffort).toBe("low");
    expect(() => setProviderBindings({ bindings: { persona: { ...binding, reasoningEffort: "invalid" }, executor: binding } })).toThrow();
  });
  it.each([
    "openai-responses",
    "openai-chat-completions",
    "anthropic-messages",
  ] as const)("saves %s as manual/unverified with secret isolated", (protocol) => {
    const result = saveProvider(input({ protocol }));
    const p = result.settings.providers[0]!;
    expect(p.baseURL).toBe("https://gateway.example/prefix/v1");
    expect(p.models[0]).toMatchObject({
      source: "manual",
      validation: { state: "unverified" },
      capabilities: { tools: "unknown" },
    });
    expect(result.runtimeActive).toBe(true);
    expect(result.credentialStatuses[p.id]).toEqual({
      set: true,
      encrypted: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(
      readFileSync(join(state.root, "provider-settings.json"), "utf8"),
    ).not.toContain("secret-value");
    expect(getProviderSettings()).toEqual(result);
  });
  it.each([
    "file:///tmp/test",
    "https://user:pass@example.com/v1",
    "https://example.com/v1?api_key=secret",
    "https://example.com/v1#secret",
    "https://example.com/v1/responses",
    "https://example.com/chat/completions",
    "http://remote.example/v1",
  ])("rejects unsafe or full endpoint %s", (url) => {
    expect(() => saveProvider(input({ baseURL: url }))).toThrow();
    expect(existsSync(join(state.root, "provider-settings.json"))).toBe(false);
  });
  it("allows local HTTP and explicit remote HTTP consent without network", () => {
    expect(validateProviderURL("http://127.0.0.1:1234/v1", false)).toBe(
      "http://127.0.0.1:1234/v1",
    );
    expect(validateProviderURL("http://[::1]:1234/v1", false)).toContain(
      "[::1]",
    );
    expect(validateProviderURL("http://gateway.example/v1", true)).toContain(
      "gateway.example",
    );
  });
  it("preserves old key/config when encryption unavailable or throws", () => {
    const original = saveProvider(input());
    const p = original.settings.providers[0]!;
    const edit = input({
      id: p.id,
      expectedRevision: p.revision,
      name: "new",
      credential: { action: "replace", value: "secret-value-beta" },
    });
    state.available = false;
    expect(() => saveProvider(edit)).toThrow("系统安全存储不可用");
    expect(getProviderSettings().settings).toEqual(original.settings);
    state.available = true;
    state.failEncrypt = true;
    expect(() => saveProvider(edit)).toThrow("encryption failed");
    expect(getProviderSettings()).toEqual(original);
  });
  it("replaces isolated credentials, preserves DeepSeek and rejects stale edits", () => {
    writeFileSync(join(state.root, "deepseek-key.enc"), "old-legacy");
    const first = saveProvider(input()).settings.providers[0]!;
    const other = saveProvider(
      input({
        name: "second",
        credential: { action: "replace", value: "other-secret" },
      }),
    ).settings.providers[1]!;
    const next = saveProvider(
      input({
        id: first.id,
        expectedRevision: 1,
        credential: { action: "replace", value: "replacement" },
      }),
    ).settings.providers.find((p) => p.id === first.id)!;
    expect(next.revision).toBe(2);
    expect(next.credentialRef).not.toBe(first.credentialRef);
    expect(readdirSync(join(state.root, "provider-credentials"))).toHaveLength(
      2,
    );
    expect(getProviderSettings().credentialStatuses[other.id]?.set).toBe(true);
    expect(() =>
      saveProvider(input({ id: first.id, expectedRevision: 1 })),
    ).toThrow("配置已更新");
    expect(readFileSync(join(state.root, "deepseek-key.enc"), "utf8")).toBe(
      "old-legacy",
    );
  });
  it("persists global/session bindings unactivated and clears references on deletion", () => {
    const p = saveProvider(input()).settings.providers[0]!;
    const bindings = {
      persona: { providerId: p.id, modelId: "custom-model" },
      executor: { providerId: p.id, modelId: "custom-model" },
    };
    setProviderBindings({ bindings });
    setProviderBindings({ sessionId: "s-中文", bindings });
    expect(getProviderSettings().settings.sessionBindings["s-中文"]).toEqual(
      bindings,
    );
    expect(() =>
      setProviderBindings({
        bindings: {
          ...bindings,
          executor: { providerId: p.id, modelId: "missing" },
        },
      }),
    ).toThrow();
    const result = deleteProvider(p.id);
    expect(result.settings.defaultBindings).toBeNull();
    expect(result.settings.sessionBindings).toEqual({});
    expect(readdirSync(join(state.root, "provider-credentials"))).toEqual([]);
  });
  it("does not overwrite malformed persisted config", () => {
    const path = join(state.root, "provider-settings.json");
    writeFileSync(path, "{bad json");
    expect(() => getProviderSettings()).toThrow("原文件已保留");
    expect(() => saveProvider(input())).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{bad json");
  });
  it("rolls back staged key when atomic configuration replacement fails", () => {
    const first = saveProvider(input());
    const p = first.settings.providers[0]!;
    state.failCommit = true;
    expect(() =>
      saveProvider(
        input({
          id: p.id,
          expectedRevision: p.revision,
          credential: { action: "replace", value: "new-secret" },
        }),
      ),
    ).toThrow("commit failed");
    expect(getProviderSettings()).toEqual(first);
    expect(readdirSync(join(state.root, "provider-credentials"))).toEqual([
      `${p.credentialRef}.enc`,
    ]);
    expect(readdirSync(state.root).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  });
  it("rejects credential/unknown fields in loaded configuration rather than returning them", () => {
    saveProvider(input());
    const path = join(state.root, "provider-settings.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.providers[0].apiKey = "leaked-key";
    writeFileSync(path, JSON.stringify(raw));
    expect(() => getProviderSettings()).toThrow("原文件已保留");
  });
  it("accepts no-auth local gateway and denies no-auth official services", () => {
    expect(
      saveProvider(
        input({
          authentication: "none",
          baseURL: "http://localhost:1234/v1",
          credential: { action: "keep" },
        }),
      ).settings.providers[0]?.credentialRef,
    ).toBeNull();
    expect(() =>
      saveProvider(
        input({ authentication: "none", baseURL: "https://api.openai.com/v1" }),
      ),
    ).toThrow("必须使用 API Key");
  });
});

it("leases a text-only model independently, blocks deletion until released and rejects stale validation", async () => {
 const {acquireChatProvider,updateProviderModels}=await import("./provider-settings.js");
 state.root=mkdtempSync(join(tmpdir(),"herta-chat-provider-"));state.available=true;state.failCommit=false;state.failEncrypt=false;
 const view=saveProvider(input());const p=view.settings.providers[0]!;
 expect(()=>acquireChatProvider(p.id,"custom-model")).toThrow();
 updateProviderModels(p.id,p.revision,models=>models.map(m=>({...m,validation:{state:"text-available",protocol:p.protocol,providerRevision:p.revision}})));
 const lease=acquireChatProvider(p.id,"custom-model");
 expect(lease.key).toBe("secret-value-alpha");
 expect(()=>deleteProvider(p.id)).toThrow();
 lease.release();lease.release();
 expect(()=>deleteProvider(p.id)).not.toThrow();
});
