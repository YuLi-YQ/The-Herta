/**
 * three's KTX2Loader imports its own copy of the Basis transcoder through
 * `new URL(…, import.meta.url)`, which Vite rewrites at build time and
 * emits under `assets/` whether or not the runtime branch that would fetch
 * it can run — ours never does: the device scene sets `transcoderPath` to
 * the scheme-served copy under `public/device-scene/basis/`. The build
 * drops the emitted pair so the asar does not carry the same 585 KB twice
 * (ADR 0057 §6.5). Only the hashed copy under assets/ is named here; the
 * served copy lives outside the bundle and is never an asset.
 */
export function isDeadTranscoderAsset(fileName: string): boolean {
  return /(^|\/)assets\/basis_transcoder[^/]*\.(js|wasm)$/.test(fileName);
}
