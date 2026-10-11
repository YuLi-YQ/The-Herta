import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { ProviderSettingsView } from "../shared/provider-settings-ipc.js";
import { normalizeModelChoice, readAppSettings } from "./app-settings.js";
import { readDeepSeekKeyPlain } from "./key-store.js";
import {
  getProviderSettings,
  restoreProviderSettingsForMigration,
  saveProvider,
} from "./provider-settings.js";
export interface ProviderMigrationResult {
  status: "migrated" | "already-migrated" | "not-needed";
  view: ProviderSettingsView;
}
/** Startup-only, called with the actual workspace. No renderer-supplied path. */
export async function migrateLegacyProvider(input: {
  workspaceRoot: string;
}): Promise<ProviderMigrationResult> {
  const root = app.getPath("userData"),
    marker = join(root, "provider-migration-v1.json");
  if (existsSync(marker))
    return { status: "already-migrated", view: getProviderSettings() };
  const old = await readAppSettings(input.workspaceRoot);
  const key = readDeepSeekKeyPlain();
  if (!key) return { status: "not-needed", view: getProviderSettings() };
  const before = getProviderSettings();
  // Existing user choices remain authoritative, even without a migration marker.
  if (before.settings.providers.length || before.settings.defaultBindings)
    return { status: "not-needed", view: before };
  const actor = normalizeModelChoice(old.models?.actor) ?? "deepseek-v4-pro";
  const executor =
    normalizeModelChoice(old.models?.backend) ?? "deepseek-flash";
  const backup = join(root, "provider-migration-backup-v1");
  mkdirSync(backup, { recursive: true });
  // Only renderer-safe configuration is duplicated. Original encrypted/plaintext
  // key files remain untouched; no secret value is put into a migration artifact.
  const priorPath = join(root, "provider-settings.json");
  if (
    existsSync(priorPath) &&
    !existsSync(join(backup, "provider-settings.json"))
  )
    writeFileSync(
      join(backup, "provider-settings.json"),
      readFileSync(priorPath),
      { mode: 0o600 },
    );
  if (!existsSync(join(backup, "metadata.json")))
    writeFileSync(
      join(backup, "metadata.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          hadProviderSettings: existsSync(priorPath),
          legacyFilesPreserved: true,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  let createdRef: string | null = null;
  try {
    const saved = saveProvider(
      {
        name: "DeepSeek（旧配置迁移）",
        protocol: "openai-chat-completions",
        baseURL: "https://api.deepseek.com/v1",
        authentication: "api-key",
        allowRemoteHTTP: false,
        models: [...new Set([actor, executor])].map((id) => ({ id })),
        defaults: { model: actor, timeoutMs: 120000 },
        credential: { action: "replace", value: key },
      },
      { personaModelId: actor, executorModelId: executor },
    );
    const provider = saved.settings.providers[0];
    if (!provider) throw new Error("Migration created no provider");
    createdRef = provider.credentialRef;
    const view = saved;
    const temp = `${marker}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temp,
        JSON.stringify({
          schemaVersion: 1,
          providerId: provider.id,
          migratedAt: new Date().toISOString(),
          requiresExplicitValidation: true,
        }),
        { mode: 0o600 },
      );
      renameSync(temp, marker);
    } finally {
      rmSync(temp, { force: true });
    }
    return { status: "migrated", view };
  } catch {
    if (createdRef)
      restoreProviderSettingsForMigration(before.settings, createdRef);
    throw new Error("旧 Provider 迁移失败；原配置与旧凭据保留，请修复后重试。");
  }
}
