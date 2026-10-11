import { useSyncExternalStore } from "react";
import { isVoiceMuted, subscribeVoiceMuted } from "./voice-prefs.js";

/** React binding for the master voice-mute pref (Settings → Voice). */
export function useVoiceMuted(): boolean {
  return useSyncExternalStore(subscribeVoiceMuted, isVoiceMuted);
}
