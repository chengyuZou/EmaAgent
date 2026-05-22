import type {
  TtsRequest,
  TtsStreamEvent,
  TtsVoiceRef,
  TtsAudioFormat,
  TtsProtocol,
} from '@ema-agent/contracts';

// Re-export contract types so consumers only import from this package
export type {
  TtsRequest,
  TtsStreamEvent,
  TtsVoiceRef,
  TtsAudioFormat,
  TtsProtocol,
} from '@ema-agent/contracts';

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
  text:         string;
  model:        string;
  voice:        TtsVoiceRef;
  format:       TtsAudioFormat;
  sampleRate?:  number;
  speed?:       number;
  instructions?: string;
  abortSignal?: AbortSignal;
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
 *   - openai-tts:     catalog only (provider voice library)
 *   - dashscope-tts:  both — catalog for system voices, clone for CosyVoice 复刻
 *   - gpt-sovits-tts: clone only (refAudio is the only identity)
 */
export const TTS_PROTOCOL_VOICE_SUPPORT: Readonly<Record<TtsProtocol, ReadonlyArray<TtsVoiceRef['kind']>>> = {
  'openai-tts':     ['catalog'],
  'dashscope-tts':  ['catalog', 'clone'],
  'gpt-sovits-tts': ['clone'],
};

export function protocolSupportsVoiceKind(
  protocol: TtsProtocol,
  kind: TtsVoiceRef['kind'],
): boolean {
  return TTS_PROTOCOL_VOICE_SUPPORT[protocol].includes(kind);
}

// ── Service-level binding (one per TtsModule) ───────────────────────────────

/**
 * The TtsClient is constructed with a per-module binding map. Each module
 * (chat / narrative / agent) has its own primary binding plus an optional
 * fallback binding. If the primary fails, the service immediately switches
 * to the fallback. If no fallback is configured, the service emits a
 * system_warning and goes silent (no audio).
 */
export interface TtsModuleBinding {
  providerConfigId: string;
  model:            string;
  /** When voice is `catalog`, this is the voiceId passed to the adapter. */
  voiceId:          string | null;
  /** Adapter-specific extras (e.g. dashscope `instructions` text). */
  config:           Record<string, unknown>;
}

// ── Request resolution result (debugging / telemetry) ───────────────────────

export interface TtsResolution {
  module:           string;
  characterId:      string | null;
  attemptedClone:   boolean;
  usedFallback:     boolean;
  protocol:         TtsProtocol;
  providerConfigId: string;
}
