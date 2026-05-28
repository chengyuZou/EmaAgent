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
// Pattern-aligned with LlmRequest: pure data, no business semantics.
// The caller (TtsCoordinator / apps/core orchestrator) is responsible for
// resolving the voice from the character card and ensuring voiceUri is
// populated before calling synthesize.

/**
 * `voice` must carry a populated `voiceUri` — the caller (apps/core) is
 * responsible for resolveVoice + ensureVoiceUri before calling synthesize.
 * TtsClient will reject requests without a voiceUri.
 *
 * `turnMode` is an optional hint for the text filter: 'agent' strips code
 * blocks more aggressively than 'chat'/'narrative'.
 */
export interface TtsRequest {
  providerId:  string;
  model:       string;
  text:        string;
  voice:       TtsVoiceRef;
  turnMode?:   TtsTurnMode;
  format?:     TtsAudioFormat;
  sampleRate?: number;
  speed?:      number;
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

// ── Health check ─────────────────────────────────────────────────────────────

export interface TtsProviderHealth {
  providerId: string;
  protocol:   TtsProtocol;
  ok:         boolean;
  /** Present when ok=false. */
  reason?:    string;
}

export interface TtsHealthResult {
  ok:        boolean;
  providers: TtsProviderHealth[];
}

// ── Adapter contract ────────────────────────────────────────────────────────

export interface TtsAdapter {
  readonly protocol: TtsProtocol;

  /**
   * Stream audio for a single text segment.
   * Receives the full TtsRequest — symmetric with LlmAdapter.stream(LlmRequest).
   */
  stream(req: TtsRequest): AsyncIterable<TtsStreamEvent>;

  /**
   * Upload a reference audio file for voice cloning.
   * Returns a URI that can be used as `voiceUri` in subsequent clone calls.
   * Not all adapters support this — unsupported adapters throw.
   */
  uploadVoice?(refAudioPath: string, promptText: string, promptLang: string, model: string): Promise<string>;
}
