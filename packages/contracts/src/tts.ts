import type { TtsProtocol } from './providers/types.js';

// ── Character voice profile (lives in character_cards.voice_profile_json) ────

/**
 * One reference audio entry. Schema is FROZEN: `id`, `label`, plus the three
 * cloning fields. Anything else (speed, voiceId, weights, providerKind) MUST
 * NOT go here — see memory:feedback-card-voice-boundary.
 *
 * `refAudioPath` is profile-scoped relative: `<cardId>/<filename>`. The TTS
 * service resolves it against `<profileDir>/voiceRefs/`. This keeps refAudio
 * portable across dataDirs (a card's voice survives swapping workspaces).
 */
export interface CharacterRefAudio {
  id:           string;
  label:        string;
  refAudioPath: string;
  promptText:   string;
  promptLang:   string;
}

/**
 * Full voice profile stored on a card. `primaryId` selects which refAudio is
 * currently in use. V1 has no auto-failover between refAudios: if primary
 * fails, TTS falls through to the system fallback voice (see memory:project-tts-scope).
 */
export interface CharacterVoiceProfile {
  refAudios: CharacterRefAudio[];
  primaryId: string | null;
}

export function emptyVoiceProfile(): CharacterVoiceProfile {
  return { refAudios: [], primaryId: null };
}

// ── Turn-modes that drive TTS (used for text filtering / logging only) ──────

/** Business mode that triggered this TTS request — kept for observability. */
export type TtsTurnMode = 'chat' | 'narrative' | 'agent';

// ── Internal voice ref (constructed by service, consumed by adapter) ─────────

/**
 * The shape an adapter actually sees. The service decides whether to send a
 * `catalog` lookup or `clone` parameters based on the binding + card state.
 *
 * - `catalog`: provider's built-in voice library (OpenAI alloy, Qwen Cherry,
 *   CosyVoice longanyang). Adapter passes voiceId straight through.
 * - `clone`:   user-supplied reference audio. Only GPT-SoVITS and CosyVoice
 *   声音复刻 / 声音设计 understand this. Other adapters reject with
 *   `unsupported_voice_kind` — service must check capability matrix first.
 */
export type TtsVoiceRef =
  | { kind: 'catalog'; voiceId: string }
  | { kind: 'clone';   refAudioPath: string; promptText: string; promptLang: string };

export type TtsAudioFormat = 'mp3' | 'pcm' | 'wav' | 'opus';

// ── TTS stream events (adapter → service → route → frontend) ────────────────

/**
 * Adapter-level stream events. The service may transform these (e.g. attach
 * `sentenceId` from the orchestrator) before they reach the frontend as
 * `EmaStreamEvent.tts_chunk` / `tts_sentence_complete`.
 */
export type TtsStreamEvent =
  | { type: 'audio_chunk';      bytes: Uint8Array<ArrayBufferLike>; mime: string }
  | { type: 'sentence_started'; index: number; text: string }
  | { type: 'sentence_done';    index: number; durationMs?: number }
  | { type: 'done';             totalBytes: number; firstByteMs: number }
  | { type: 'error';            code: TtsErrorCode; message: string };

/**
 * Coarse error classes used by the failover logic. Specifically:
 *   - `permanent_*` → service immediately falls through to system fallback
 *   - `transient_*` → adapter is responsible for its own internal retry; the
 *     service does NOT retry these (we don't cycle refAudios in V1).
 */
export type TtsErrorCode =
  | 'permanent_refaudio_missing'
  | 'permanent_credentials'
  | 'permanent_unsupported_voice_kind'
  | 'permanent_unsupported_model'
  | 'permanent_bad_request'
  | 'transient_network'
  | 'transient_timeout'
  | 'transient_server'
  | 'unknown';

// ── Re-exports of protocol unions for convenience ───────────────────────────

export type { TtsProtocol };
