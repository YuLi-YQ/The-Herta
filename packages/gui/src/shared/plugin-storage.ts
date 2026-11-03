/** Logical file lengths across owned plugin namespaces, not OS disk allocation. */
export type PluginStorageCategoryId = "packages" | "private-data" | "artifacts" | "proposals" | "workshop";
export interface PluginStorageCategory {
  readonly id: PluginStorageCategoryId;
  readonly usedBytes: number;
  readonly fileCount: number;
}
export interface PluginStorageSnapshot {
  readonly status: "ready";
  readonly usedBytes: number;
  readonly limitBytes: number;
  readonly availableBytes: number;
  readonly fileCount: number;
  readonly categories: readonly PluginStorageCategory[];
  readonly overLimit: boolean;
}
