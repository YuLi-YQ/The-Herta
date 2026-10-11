import { useSyncExternalStore } from "react";
import { isVoicePlaying, subscribeVoicePlaying } from "./play-voice.js";

/**
 * True while a voice clip is playing. The voice aura subscribes so an audio-only
 * cue (e.g. the easter egg, which streams no text) still drives the card's
 * speaking state — text-driven speech already sets `status: "speaking"`.
 */
export function useVoicePlaying(): boolean {
  return useSyncExternalStore(subscribeVoicePlaying, isVoicePlaying);
}
