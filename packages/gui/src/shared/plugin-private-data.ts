export type PrivatePluginDataAction = "restore" | "reset";
export interface PrivatePluginDataInfo {
  readonly state: "missing" | "valid" | "damaged";
  readonly bytes: number;
  readonly keys?: number;
  readonly savedAt?: string;
}
/** Metadata only: private values and filesystem paths never enter the UI. */
export interface PrivatePluginDataPreview {
  readonly id: string;
  readonly pluginId: string;
  readonly action: PrivatePluginDataAction;
  readonly hostRevision: number;
  readonly expiresAt: string;
  readonly current: PrivatePluginDataInfo;
  readonly backup: PrivatePluginDataInfo;
  readonly canConfirm: boolean;
  readonly warning?: string;
}
export interface PrivatePluginDataResult {
  readonly pluginId: string;
  readonly action: PrivatePluginDataAction;
  readonly keys: number;
  readonly bytes: number;
  readonly archived: boolean;
}
