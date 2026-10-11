export interface TarEntry {
  readonly path: string;
  readonly data: Uint8Array;
}
export function packTar(entries: readonly TarEntry[]): Buffer;
export function packTarGz(entries: readonly TarEntry[]): Buffer;
