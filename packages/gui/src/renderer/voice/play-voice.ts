import { voiceClipUrl } from "../../shared/voice.js";
import {
  applySpeechVolume,
  isSpeechPlaying,
  stopSpeech,
  subscribeSpeechPlaying,
} from "./speech-player.js";
import { getVoiceVolume, isVoiceMuted } from "./voice-prefs.js";

/**
 * Audio elements that are currently playing (or about to). Tracked so a session
 * change can cut them off — fire-and-forget playback would otherwise keep
 * sounding after the user switches / deletes / starts a new session. Each entry
 * removes itself on `ended`/`error` so the set doesn't grow unbounded.
 */
const active = new Set<HTMLAudioElement>();

// Observers of "is any voice clip currently playing" — the voice aura subscribes
// so an audio-only cue (e.g. the easter egg, which streams no text) still drives
// the card's speaking state. Notified on every start/stop; `useSyncExternalStore`
// dedupes by the boolean snapshot, so redundant notifications are free.
const playingListeners = new Set<() => void>();
function notifyPlaying(): void {
  for (const l of playingListeners) l();
}

/** True while at least one voice clip — recorded OR synthesized (ADR 0042)
 *  — is playing. Both feed the aura's speaking state. */
export function isVoicePlaying(): boolean {
  return active.size > 0 || isSpeechPlaying();
}

/** Subscribe to changes in `isVoicePlaying()`. Returns an unsubscribe fn. */
export function subscribeVoicePlaying(listener: () => void): () => void {
  playingListeners.add(listener);
  const unsubSpeech = subscribeSpeechPlaying(listener);
  return () => {
    playingListeners.delete(listener);
    unsubSpeech();
  };
}

/**
 * Autoplay a voice clip (`<voiceRoot>/<category>/<clipId>.opus`, served over the
 * herta-voice:// protocol). Best-effort: a missing clip or a blocked play()
 * rejection is swallowed — voice is non-essential and must never break the UI.
 *
 * Exported separately from the hook so it can be unit-tested with a stubbed
 * Audio constructor.
 */
export function playVoiceClip(category: string, clipId: string): void {
  // Master mute (Settings → Voice): drop the cue entirely — no Audio is created,
  // so `isVoicePlaying` stays false and the aura won't show a speaking state.
  if (isVoiceMuted()) return;
  // One Herta voice at a time (newest wins): stop any in-flight clip before
  // starting this one so two clips never overlap — e.g. lifting the 板砖 device
  // mid-opening interrupts the opening rather than talking over it.
  stopAllVoice();
  try {
    const audio = new Audio(voiceClipUrl(category, clipId));
    // Master volume (Settings → Voice): scale every clip at creation; a
    // mid-clip slider drag re-applies via applyVoiceVolume below.
    audio.volume = getVoiceVolume();
    active.add(audio);
    notifyPlaying();
    const release = (): void => {
      active.delete(audio);
      notifyPlaying();
    };
    audio.addEventListener("ended", release, { once: true });
    audio.addEventListener("error", release, { once: true });
    void audio.play().catch(() => {
      release();
    });
  } catch {
    // ignore — best-effort playback
  }
}

/**
 * Stop every clip that is currently playing and forget it. Idempotent — call on
 * any session change (switch / new / delete / reset) so the previous session's
 * voice doesn't bleed into the next. A clip that starts AFTER this call (e.g. a
 * brand-new session's opening cue) is unaffected: its element isn't in `active`
 * yet, so this can never cut off the next session's voice.
 */
/**
 * Re-apply the current master volume to every clip that is ALREADY playing —
 * called by the Settings slider so a drag is audible immediately instead of
 * only affecting the next clip. Best-effort per element.
 */
export function applyVoiceVolume(): void {
  const v = getVoiceVolume();
  for (const audio of active) {
    try {
      audio.volume = v;
    } catch {
      // ignore — best-effort
    }
  }
  // Synthesized speech rides its own gain node (ADR 0042).
  applySpeechVolume();
}

export function stopAllVoice(): void {
  for (const audio of active) {
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch {
      // ignore — best-effort
    }
  }
  active.clear();
  // Everything that cuts clip playback — the stop click, a session switch, a
  // failed turn — must cut her SYNTHESIZED voice too, or she keeps talking
  // over the next session (ADR 0042).
  stopSpeech();
  notifyPlaying();
}
