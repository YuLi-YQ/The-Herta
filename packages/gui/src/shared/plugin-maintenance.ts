export type PluginMaintenanceCategory = "blob" | "temporary" | "archive";
export interface PluginMaintenanceItem {
  readonly id: string;
  readonly category: PluginMaintenanceCategory;
  readonly label: string;
  readonly bytes: number;
  readonly fileCount: number;
  readonly linkCount: number;
  readonly warning?: string;
}
export interface PluginMaintenancePreview {
  readonly id: string;
  readonly hostRevision: number;
  readonly expiresAt: string;
  readonly items: readonly PluginMaintenanceItem[];
  readonly blockedReasons: readonly string[];
  readonly protectedBlobCount: number;
  readonly usageKnown: boolean;
}
export interface PluginMaintenanceResult {
  /** Completed selected preview items, not individual descendants. */
  readonly deletedCount: number;
  /** Verified logical bytes of ordinary files actually removed, even in a partial item. */
  readonly deletedBytes: number;
  /** Selected items not fully removed; includes failedCount. */
  readonly retainedCount: number;
  readonly failedCount: number;
  readonly cancelled: boolean;
  readonly usageKnown: boolean;
  readonly issues: readonly string[];
}
