import type { TtsProtocol } from '@ema-agent/contracts';

// Re-export TtsProtocol — it lives in contracts because it's derived from
// ProtocolFamily (the provider registry needs it). Everything else is
// TTS-package–internal.
export type { TtsProtocol } from '@ema-agent/contracts';

// ── TTS-internal types ────────────────────────────────────────────────────────

/** Resolved voice reference passed into every synthesize call. */
export interface TtsVoiceRef {
  /** Profile-scoped relative path to the reference audio file. */
  refAudioPath: string;
  /** Prompt text used for voice cloning (empty ok for some providers). */
  promptText:   string;
  /** Language code, e.g. 'zh', 'en'. */
  promptLang:   string;
  /**
   * Provider-assigned voice URI.
   * Required by openai-tts and dashscope-tts — those adapters check and yield
   * a `permanent_unsupported_voice_kind` error when absent.
   * gpt-sovits-tts ignores this field and uses `refAudioPath` directly.
   *
   * Populated lazily by `ensureVoiceUri()` in apps/core before the coordinator
   * starts. Never hardcode a value here.
   */
  voiceUri?: string;
}

/** Output audio format requested from the adapter. */
export type TtsAudioFormat = 'mp3' | 'pcm' | 'wav' | 'opus';

/** Coarse error classes emitted by adapters. */
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

/** Wire events emitted by adapters. */
export type TtsStreamEvent =
  | { type: 'audio_chunk';     bytes: Uint8Array<ArrayBufferLike>; mime: string }
  | { type: 'sentence_started'; index: number; text: string }
  | { type: 'sentence_done';    index: number; durationMs?: number }
  | { type: 'done';             totalBytes: number; firstByteMs: number }
  | { type: 'error';            code: TtsErrorCode; message: string };

// ── Public TTS request (Façade entry point) ───────────────────────────────────
//
// Pattern-aligned with LlmRequest: pure data, no business semantics.
// The caller (TtsCoordinator / apps/core orchestrator) is responsible for
// resolving the voice from the character card and ensuring voiceUri is
// populated before calling synthesize for cloud adapters.

/**
 * Fully-resolved synthesis request.
 *
 * `voice` is resolved from the active character card by apps/core.
 * For openai-tts and dashscope-tts protocols `voice.voiceUri` must be
 * populated before calling `synthesize()`; the adapter will yield
 * `permanent_unsupported_voice_kind` otherwise.
 * gpt-sovits-tts reads `voice.refAudioPath` directly and never needs voiceUri.
 */
export interface TtsRequest {
  providerId:   string;
  model:        string;
  text:         string;
  voice:        TtsVoiceRef;
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

export interface TtsProbeResult {
  ok:        boolean;
  latencyMs?: number;
  error?:    string;
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

  /** Live connectivity check. Optional — service falls back to ok=false when absent. */
  probe?(): Promise<Omit<TtsProbeResult, never>>;
}
