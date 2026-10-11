// @vitest-environment node
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  root: "",
  workspace: "",
  available: true,
  failMarker: false,
}));
vi.mock("electron", () => ({
  app: { getPath: () => state.root },
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (s: string) => Buffer.from(s).map((b) => b ^ 85),
    decryptString: (b: Buffer) => Buffer.from(b.map((v) => v ^ 85)).toString(),
  },
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (state.failMarker && to.endsWith("provider-migration-v1.json"))
        throw new Error("marker failure");
      return fs.renameSync(from, to);
    },
  };
});

import { writeAppSettings } from "./app-settings.js";
import { migrateLegacyProvider } from "./provider-migration.js";
import { getProviderSettings, saveProvider } from "./provider-settings.js";

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "herta-r3-migrate-"));
  state.workspace = mkdtempSync(join(tmpdir(), "黑塔 迁移（合成）-"));
  state.available = true;
  state.failMarker = false;
});
const fixture = async () => {
  writeFileSync(
    join(state.root, "deepseek-key.txt"),
    "fixture-only-synthetic-key",
  );
  await writeAppSettings(state.workspace, {
    models: { actor: "deepseek-v4-pro", backend: "deepseek-flash" },
    backend: { thinking: "high" },
  });
};
it("no legacy key leaves configuration untouched", async () => {
  expect(
    (await migrateLegacyProvider({ workspaceRoot: state.workspace })).status,
  ).toBe("not-needed");
  expect(existsSync(join(state.root, "provider-settings.json"))).toBe(false);
});
it("synthetic legacy fixture migrates OS-store reference/roles, leaves original and is idempotent", async () => {
  await fixture();
  const before = readFileSync(join(state.workspace, ".herta", "settings.json"));
  const result = await migrateLegacyProvider({
    workspaceRoot: state.workspace,
  });
  expect(result.status).toBe("migrated");
  const p = result.view.settings.providers[0]!;
  expect(p.protocol).toBe("openai-chat-completions");
  expect(p.models.map((m) => m.id)).toEqual([
    "deepseek-v4-pro",
    "deepseek-flash",
  ]);
  expect(result.view.settings.defaultBindings?.executor.modelId).toBe(
    "deepseek-flash",
  );
  expect(p.models.every((m) => m.validation.state === "unverified")).toBe(true);
  expect(
    readFileSync(join(state.root, "provider-settings.json"), "utf8"),
  ).not.toContain("fixture-only");
  expect(readFileSync(join(state.root, "deepseek-key.txt"), "utf8")).toBe(
    "fixture-only-synthetic-key",
  );
  expect(
    readFileSync(join(state.workspace, ".herta", "settings.json")),
  ).toEqual(before);
  expect(
    existsSync(
      join(state.root, "provider-migration-backup-v1", "metadata.json"),
    ),
  ).toBe(true);
  expect(
    (await migrateLegacyProvider({ workspaceRoot: state.workspace })).status,
  ).toBe("already-migrated");
  expect(getProviderSettings().settings.providers).toHaveLength(1);
});
it("existing R2 provider choices are preserved", async () => {
  await fixture();
  const existing = saveProvider({
    name: "existing",
    protocol: "anthropic-messages",
    baseURL: "https://example.invalid/v1",
    authentication: "none",
    allowRemoteHTTP: false,
    models: [{ id: "manual" }],
    defaults: { model: "manual", timeoutMs: 2000 },
    credential: { action: "keep" },
  });
  expect(
    (await migrateLegacyProvider({ workspaceRoot: state.workspace })).status,
  ).toBe("not-needed");
  expect(getProviderSettings()).toEqual(existing);
});
it("encryption unavailable fails without altering legacy/config", async () => {
  await fixture();
  state.available = false;
  await expect(
    migrateLegacyProvider({ workspaceRoot: state.workspace }),
  ).rejects.toThrow("迁移失败");
  expect(getProviderSettings().settings.providers).toHaveLength(0);
  expect(existsSync(join(state.root, "provider-migration-v1.json"))).toBe(
    false,
  );
  expect(readFileSync(join(state.root, "deepseek-key.txt"), "utf8")).toContain(
    "fixture-only",
  );
});
it("marker commit failure rolls back provider, bindings and newly encrypted credential; retry succeeds", async () => {
  await fixture();
  state.failMarker = true;
  await expect(
    migrateLegacyProvider({ workspaceRoot: state.workspace }),
  ).rejects.toThrow("迁移失败");
  expect(getProviderSettings().settings).toMatchObject({
    providers: [],
    defaultBindings: null,
  });
  expect(readdirSync(join(state.root, "provider-credentials"))).toHaveLength(0);
  expect(readFileSync(join(state.root, "deepseek-key.txt"), "utf8")).toContain(
    "fixture-only",
  );
  state.failMarker = false;
  expect(
    (await migrateLegacyProvider({ workspaceRoot: state.workspace })).status,
  ).toBe("migrated");
});
