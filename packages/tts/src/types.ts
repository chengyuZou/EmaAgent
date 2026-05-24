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
 * error notices). In that case the service skips the card lookup and goes
 * straight to fallback catalog voice.
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
 * What an adapter actually receives. `voice` is already resolved (catalog or
 * clone) — adapter MUST throw `permanent_unsupported_voice_kind` if it sees
 * a kind it does not support. The capability matrix in `service.ts` ensures
 * this only happens on programmer error, not user-config error.
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
   * Stream audio for a single text segment. Implementations should:
   *   - Emit `audio_chunk` events as soon as bytes arrive (low latency).
   *   - Emit exactly one `done` (success) OR `error` (failure) — never both.
   *   - Honor `abortSignal` and stop emitting after it fires.
   *   - Surface known protocol errors with the appropriate `TtsErrorCode`,
   *     not as unhandled exceptions.
   */
  stream(call: TtsAdapterCall): AsyncIterable<TtsStreamEvent>;
}

// ── Voice-kind capability per protocol (single source of truth) ─────────────

/**
 * Which TtsVoiceRef kinds each protocol can handle.
 *
 *   - openai-tts:     catalog only — provider voice library (alloy / Cherry / etc.)
 *   - dashscope-tts:  catalog only in V1. Aliyun 声音复刻 needs a separate
 *                     "register refAudio → get voice_id" call (paid + stateful);
 *                     once registered the voice_id behaves like a catalog voice
 *                     anyway, so for V1 we accept only catalog. Auto-registration
 *                     from CharacterRefAudio is V1.5 (settings page button).
 *   - gpt-sovits-tts: clone only — refAudio is the entire identity, no catalog
 */
export const TTS_PROTOCOL_VOICE_SUPPORT: Readonly<Record<TtsProtocol, ReadonlyArray<TtsVoiceRef['kind']>>> = {
  'openai-tts':     ['catalog'],
  'dashscope-tts':  ['catalog'],
  'gpt-sovits-tts': ['clone'],
};

export function protocolSupportsVoiceKind(
  protocol: TtsProtocol,
  kind: TtsVoiceRef['kind'],
): boolean {
  return TTS_PROTOCOL_VOICE_SUPPORT[protocol].includes(kind);
}

// ── Request resolution result (debugging / telemetry) ───────────────────────

export interface TtsResolution {
  /** Business mode that triggered TTS ('chat' | 'narrative' | 'agent'). */
  turnMode:         string;
  characterId:      string | null;
  attemptedClone:   boolean;
  usedFallback:     boolean;
  protocol:         TtsProtocol;
  providerConfigId: string;
}
