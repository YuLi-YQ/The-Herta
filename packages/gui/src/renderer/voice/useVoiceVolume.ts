import { useSyncExternalStore } from "react";
import { getVoiceVolume, subscribeVoiceVolume } from "./voice-prefs.js";

/** React binding for the master voice-volume pref (Settings → Voice). */
export function useVoiceVolume(): number {
  return useSyncExternalStore(subscribeVoiceVolume, getVoiceVolume);
}
