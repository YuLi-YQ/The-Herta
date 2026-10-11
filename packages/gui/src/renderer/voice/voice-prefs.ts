const MUTED_KEY = "herta.voice.muted";

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === "1";
  } catch {
    return false;
  }
}

let muted = readMuted();
const listeners = new Set<() => void>();

/** True when the user has muted all of Herta's voice (Settings → Voice). */
export function isVoiceMuted(): boolean {
  return muted;
}

/**
 * Set (and persist) the master voice mute. Notifies subscribers on change.
 * Cutting any in-flight clip is the caller's job (see VoiceSettings) to keep
 * this module free of a play-voice import cycle.
 */
export function setVoiceMuted(next: boolean): void {
  if (next === muted) return;
  muted = next;
  try {
    localStorage.setItem(MUTED_KEY, next ? "1" : "0");
  } catch {
    // ignore — best-effort persistence
  }
  for (const l of listeners) l();
}

/** Subscribe to mute changes. Returns an unsubscribe fn. */
export function subscribeVoiceMuted(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ── Master volume (Settings → Voice, 2026-07-11) ────────────────────────────

const VOLUME_KEY = "herta.voice.volume";

/** Clamp to the valid HTMLAudioElement volume range. Non-finite → full. */
function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

function readVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw === null) return 1;
    return clampVolume(Number(raw));
  } catch {
    return 1;
  }
}

let volume = readVolume();
const volumeListeners = new Set<() => void>();

/** The master voice volume, 0..1 (default 1). Independent of the mute:
 *  mute gates playback entirely; this scales an unmuted clip. */
export function getVoiceVolume(): number {
  return volume;
}

/**
 * Set (and persist) the master voice volume (clamped to 0..1). Notifies
 * subscribers on change. Applying it to a clip that is ALREADY playing is the
 * caller's job (see VoiceSettings → applyVoiceVolume) to keep this module
 * free of a play-voice import cycle, mirroring the mute above.
 */
export function setVoiceVolume(next: number): void {
  const clamped = clampVolume(next);
  if (clamped === volume) return;
  volume = clamped;
  try {
    localStorage.setItem(VOLUME_KEY, String(clamped));
  } catch {
    // ignore — best-effort persistence
  }
  for (const l of volumeListeners) l();
}

/** Subscribe to volume changes. Returns an unsubscribe fn. */
export function subscribeVoiceVolume(listener: () => void): () => void {
  volumeListeners.add(listener);
  return () => {
    volumeListeners.delete(listener);
  };
}
