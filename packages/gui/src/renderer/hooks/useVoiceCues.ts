import { useEffect } from "react";
import { useHertaBridge } from "../context/HertaBridgeContext.js";
import { playVoiceClip, stopAllVoice } from "../voice/play-voice.js";
import { playSpeechUnit, stopSpeech } from "../voice/speech-player.js";

/**
 * Subscribe to the server's voice cues and autoplay each clip. Mount once at the
 * app root (inside the bridge provider). Currently the only cue is the opening
 * voice; veto / particle / easter-egg cues will arrive on the same channel.
 * No mute yet — a settings toggle gates this later.
 *
 * Also cuts in-flight playback on any session change so the previous session's
 * voice never bleeds into the next: `onReset` covers switch / new / open /
 * no-session, `onSessionDeleted` covers deleting the open session. A brand-new
 * session's opening cue arrives AFTER its reset, so stopping on reset can't kill
 * it (the new element isn't tracked when stopAllVoice runs).
 */
export function useVoiceCues(): void {
  const { bridge, sessionStore } = useHertaBridge();
  useEffect(() => {
    const unsubs = [
      bridge.onVoice((e) => {
        // Tolerate a cue with no clip (slice 4: EN openings carry no voice —
        // the server shouldn't emit one, but a blank/absent clipId must never
        // request `openings/undefined.opus`).
        if (e.kind === "cue" && typeof e.clipId === "string" && e.clipId !== "")
          playVoiceClip(e.category, e.clipId);
        // Synthesized speech (ADR 0042): one PCM buffer per sentence unit,
        // scheduled gapless after the previous one.
        else if (e.kind === "tts") playSpeechUnit(e);
        else if (e.kind === "ttsStop") stopSpeech(e.utteranceId);
      }),
      bridge.onReset(() => stopAllVoice()),
      // Scoped to the OPEN session (audit 2026-07-24, M8). Deleting some other
      // old session from the sidebar is allowed mid-turn, and an unscoped
      // handler cut Herta's in-flight clip mid-sentence while the text kept
      // typing at the clip-matched pace — audio and reveal desynchronized for
      // the rest of the line. The store guards the same event identically
      // (`e.sessionId === this.snapshot.sessionId`).
      bridge.onSessionDeleted((e) => {
        if (e.sessionId === sessionStore.getSnapshot().sessionId) {
          stopAllVoice();
        }
      }),
      // Any failed turn silences her: interrupted or errored, the speech the
      // clip belongs to is gone (user 2026-07-13). Natural finishes
      // deliberately DON'T cut — the opening text's pacing matches the clip,
      // and turn.finished can land moments before the audio's tail. NOTE:
      // this cannot cover the opening's interrupt-as-SKIP, which finishes the
      // turn normally — the Composer's stop button cuts voice on the click
      // itself for that (and every other) case.
      bridge.onTurn((e) => {
        if (e.kind === "failed") stopAllVoice();
      }),
    ];
    return () => {
      for (const u of unsubs) u();
    };
  }, [bridge, sessionStore]);
}
