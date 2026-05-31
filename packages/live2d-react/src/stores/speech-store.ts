// ── SpeechAnimationStore ─────────────────────────────────────────────────────
//
// Minimal Zustand bridge between TTS audio playback (desktop-ui) and
// Live2D animation plugins (live2d-react).
//
//   - desktop-ui/tts-playback.ts  WRITES  rms + speaking
//   - live2d-react/audio-lipsync   READS   rms → ParamMouthOpenY
//   - live2d-react/random-idle     READS   speaking → suppress idle motions
//
// Single-direction data flow. No circular imports. No dependency on
// SSE, Turn, LLM, or any other package.

import { create } from 'zustand';

export interface SpeechAnimationState {
  /** True while TTS audio is actively playing (not just queued). */
  speaking: boolean;
  /** Raw audio volume 0–1, updated ~60 Hz from AnalyserNode. */
  rms: number;
  /** Smoothed RMS for body accent — trails behind `rms` with decay. */
  energy: number;
}

export interface SpeechAnimationActions {
  setSpeaking(speaking: boolean): void;
  /** Called every frame by the audio analyser loop. */
  setRms(rms: number): void;
  reset(): void;
}

export type SpeechAnimationStore = SpeechAnimationState & SpeechAnimationActions;

export const useSpeechStore = create<SpeechAnimationStore>((set) => ({
  speaking: false,
  rms:      0,
  energy:   0,

  setSpeaking(speaking) { set({ speaking }); },
  setRms(rms) {
    set((s) => ({
      rms,
      // energy decays slowly — rises fast, falls slow
      energy: rms > s.energy
        ? rms
        : s.energy + (rms - s.energy) * 0.05,
    }));
  },
  reset() { set({ speaking: false, rms: 0, energy: 0 }); },
}));
