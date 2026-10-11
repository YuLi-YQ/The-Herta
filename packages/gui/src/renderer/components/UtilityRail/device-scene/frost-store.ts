import type { ResolvedTheme } from "../../../hooks/useResolvedTheme.js";

/**
 * The frosted-glass picture the card shows while its 3D scene builds (ADR
 * 0057 §2.13): a small JPEG of the scene's own last rendering, one per
 * theme, kept in localStorage across launches. The owner's point: the
 * flat art is a different drawing of the device from the model, so the
 * glass should show the 3D itself. A launch that has never shown the
 * scene has nothing here and shows the bundled rendering of the scene
 * (DeviceCard's DEFAULT_FROST) instead.
 */
const KEY_PREFIX = "herta.deviceScene.frost.";
/** A quarter-size JPEG is ~4 KB; anything past this is not ours. */
const MAX_LENGTH = 64_000;

export function readFrost(theme: ResolvedTheme): string | null {
  try {
    const value = localStorage.getItem(KEY_PREFIX + theme);
    if (value === null) return null;
    return value.startsWith("data:image/") && value.length <= MAX_LENGTH
      ? value
      : null;
  } catch {
    return null;
  }
}

export function writeFrost(theme: ResolvedTheme, dataUrl: string): void {
  if (!dataUrl.startsWith("data:image/") || dataUrl.length > MAX_LENGTH) {
    return;
  }
  try {
    localStorage.setItem(KEY_PREFIX + theme, dataUrl);
  } catch {
    // Quota or a locked-down storage: the next launch shows the bundled
    // picture.
  }
}

/** Test hook. */
export function clearFrostForTest(): void {
  try {
    localStorage.removeItem(`${KEY_PREFIX}light`);
    localStorage.removeItem(`${KEY_PREFIX}dark`);
  } catch {
    // nothing to clear
  }
}
