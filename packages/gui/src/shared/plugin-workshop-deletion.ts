/** Exact host-owned draft deletion preview. No filesystem paths or contents. */
export interface PluginWorkshopDeletePreview {
  readonly id: string;
  readonly draftId: string;
  readonly name?: string;
  readonly damaged: boolean;
  readonly bytes: number | null;
  readonly fileCount: number | null;
  readonly expiresAt: string;
  readonly canConfirm: boolean;
  readonly warning?: string;
}
export interface PluginWorkshopDeleteResult {
  readonly draftId: string;
  readonly deleted: boolean;
  readonly deletedFiles: number;
  readonly deletedBytes: number;
  readonly remainingFiles: number;
  readonly cancelled: boolean;
  readonly message: string;
}
