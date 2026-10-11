// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", available: true }));
vi.mock("electron", () => ({
  app: { getPath: () => state.root },
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

import {
  acquireTurnProviders,
  getProviderReadiness,
  saveProvider,
  setProviderBindings,
  updateProviderModels,
} from "./provider-settings.js";

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "herta-r6-readiness-"));
  state.available = true;
});
function connection(name = "test", credential = true) {
  return saveProvider({
    name,
    protocol: "openai-responses",
    baseURL: "https://example.invalid",
    authentication: "api-key",
    allowRemoteHTTP: false,
    models: [{ id: "test-model" }],
    defaults: { model: "test-model", timeoutMs: 2000 },
    credential: credential
      ? { action: "replace", value: "synthetic-unit-secret" }
      : { action: "keep" },
  }).settings.providers.find((p) => p.name === name)!;
}
function bindings(providerId: string) {
  const binding = { providerId, modelId: "test-model" };
  return { persona: binding, executor: binding };
}
function validate(providerId: string, tools = true) {
  updateProviderModels(providerId, 1, (models) =>
    models.map((model) => ({
      ...model,
      validation: {
        ...model.validation,
        state: tools ? "tools-available" : "text-available",
      },
      capabilities: {
        ...model.capabilities,
        tools: tools ? "supported" : "unknown",
      },
    })),
  );
}
it("reports missing binding without starting a turn", () => {
  expect(getProviderReadiness("actual-session")).toMatchObject({
    ready: false,
    sessionId: "actual-session",
    scope: "global",
    issue: { code: "no-binding" },
  });
  expect(() => acquireTurnProviders("actual-session", "turn")).toThrow(
    "尚未选择",
  );
});
it("uses the effective session override and falls back only after explicit removal", () => {
  const global = connection("global"),
    override = connection("override");
  validate(global.id);
  setProviderBindings({ bindings: bindings(global.id) });
  setProviderBindings({
    sessionId: "actual-session",
    bindings: bindings(override.id),
  });
  expect(getProviderReadiness("other-session")).toMatchObject({
    ready: true,
    scope: "global",
  });
  expect(getProviderReadiness("actual-session")).toMatchObject({
    ready: false,
    scope: "session",
    issue: { code: "model-unverified" },
  });
  setProviderBindings({ sessionId: "actual-session", bindings: null });
  expect(getProviderReadiness("actual-session")).toMatchObject({
    ready: true,
    scope: "global",
  });
});
it("requires executor tool validation even when text validation succeeds", () => {
  const provider = connection();
  setProviderBindings({ bindings: bindings(provider.id) });
  validate(provider.id, false);
  expect(getProviderReadiness()).toMatchObject({
    ready: false,
    issue: { code: "tools-unavailable", role: "executor" },
  });
  expect(() => acquireTurnProviders("session", "turn")).toThrow("工具能力");
});
it("distinguishes absent credentials, unavailable secure storage, and missing encrypted files without exposing a key", () => {
  const absent = connection("absent", false);
  setProviderBindings({ bindings: bindings(absent.id) });
  expect(getProviderReadiness().issue?.code).toBe("missing-credential");
  const provider = connection();
  validate(provider.id);
  setProviderBindings({ bindings: bindings(provider.id) });
  state.available = false;
  expect(getProviderReadiness().issue?.code).toBe("credential-unavailable");
  state.available = true;
  rmSync(
    join(state.root, "provider-credentials", `${provider.credentialRef}.enc`),
  );
  expect(getProviderReadiness().issue?.code).toBe("credential-unavailable");
  expect(JSON.stringify(getProviderReadiness())).not.toContain(
    "synthetic-unit-secret",
  );
});
it("does not trust malformed stored settings or discard the original file", () => {
  const path = join(state.root, "provider-settings.json");
  writeFileSync(path, "malformed-config");
  expect(getProviderReadiness().issue?.code).toBe("settings-unreadable");
  expect(readFileSync(path, "utf8")).toBe("malformed-config");
});
it("reads a legitimate older validation as expired and refuses a turn after configuration changes", () => {
  const provider = connection();
  validate(provider.id);
  setProviderBindings({ bindings: bindings(provider.id) });
  saveProvider({
    id: provider.id,
    expectedRevision: 1,
    name: "edited",
    protocol: "openai-responses",
    baseURL: "https://changed.example.invalid",
    authentication: "api-key",
    allowRemoteHTTP: false,
    models: [{ id: "test-model" }],
    defaults: { model: "test-model", timeoutMs: 2000 },
    credential: { action: "keep" },
  });
  expect(getProviderReadiness()).toMatchObject({
    ready: false,
    issue: { code: "validation-expired" },
  });
  expect(() => acquireTurnProviders("session", "turn")).toThrow("重新验证");
});
it("rejects impossible future validation revisions instead of trusting corrupt evidence", () => {
  const provider = connection();
  setProviderBindings({ bindings: bindings(provider.id) });
  const path = join(state.root, "provider-settings.json");
  const data = JSON.parse(readFileSync(path, "utf8"));
  data.providers[0].models[0].validation.providerRevision = 99;
  writeFileSync(path, JSON.stringify(data));
  expect(getProviderReadiness().issue?.code).toBe("settings-unreadable");
});
