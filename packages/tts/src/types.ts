import type { CharacterCardId } from '@ema-agent/contracts';
import type {
  TtsStreamEvent,
  TtsVoiceRef,
  TtsAudioFormat,
  TtsTurnMode,
  TtsProtocol,
} from '@ema-agent/contracts';

// Re-export shared contract types so consumers only import from this package
export type {
  TtsStreamEvent,
  TtsVoiceRef,
  TtsAudioFormat,
  TtsTurnMode,
  TtsProtocol,
} from '@ema-agent/contracts';

// ── Public TTS request (Façade entry point) ───────────────────────────────────
//
// Defined here (not in contracts) — symmetric with LlmRequest in @ema-agent/llm.
// Callers (orchestrator) resolve providerId + model from model_bindings before
// calling TtsClient. The client is a thin adapter dispatcher only.

/**
 * `characterId` may be `null` for system-originated narration (boot greeting,
 * error notices). In that case TTS is skipped — system messages are text-only.
 */
export interface TtsRequest {
  /** provider_configs.id UUID — which adapter instance to use. */
  providerId:   string;
  /** Model name as the provider expects it (e.g. "tts-1", "cosyvoice-v1"). */
  model:        string;
  text:         string;
  characterId:  CharacterCardId | null;
  /** Business mode that triggered this — used for text filtering + logging. */
  turnMode?:    TtsTurnMode;
  format?:      TtsAudioFormat;
  sampleRate?:  number;
  speed?:       number;
  abortSignal?: AbortSignal;
}

// ── Provider config (per-protocol credentials & endpoint) ────────────────────

export interface TtsProviderConfig {
  /** matches provider_configs.id in profile.db */
  id:       string;
  protocol: TtsProtocol;
  apiKey:   string;
  baseUrl:  string;
}

// ── Adapter call arguments (constructed by TtsClient, consumed by adapter) ──

/**
 * What an adapter actually receives. `voice` is already resolved from the
 * character card's voiceProfile — it always carries refAudioPath + promptText
 * + promptLang. V1 is clone-only (no catalog/system-voice path).
 */
export interface TtsAdapterCall {
  text:          string;
  model:         string;
  voice:         TtsVoiceRef;
  format:        TtsAudioFormat;
  sampleRate?:   number;
  speed?:        number;
  instructions?: string;
  abortSignal?:  AbortSignal;
}

// ── Adapter contract ────────────────────────────────────────────────────────

export interface TtsAdapter {
  readonly protocol: TtsProtocol;

  /**
   * Stream audio for a single text segment.
   */
  stream(call: TtsAdapterCall): AsyncIterable<TtsStreamEvent>;

  /**
   * Upload a reference audio file for voice cloning.
   * Returns a URI that can be used as `voiceUri` in subsequent clone calls.
   * Not all adapters support this — unsupported adapters throw.
   */
  uploadVoice?(refAudioPath: string, promptText: string, promptLang: string, model: string): Promise<string>;
}
