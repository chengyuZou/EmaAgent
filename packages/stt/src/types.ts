import type { SttProtocol } from '@ema-agent/contracts';

// Re-export protocol enum so consumers only import from this package
export type { SttProtocol } from '@ema-agent/contracts';

// ── Public STT request (Façade entry point) ───────────────────────────────────
//
// Defined here (not in contracts) — symmetric with LlmRequest in @ema-agent/llm.
// Callers (orchestrator) resolve providerId + model from model_bindings before
// calling SttClient. The client is a thin adapter dispatcher only.

export interface SttRequest {
  /** provider_configs.id UUID — which adapter instance to use. */
  providerId:   string;
  /** Model name as the provider expects it (e.g. "whisper-1"). */
  model:        string;
  audio:        Uint8Array;
  mime:         string;
  language?:    string;
  abortSignal?: AbortSignal;
}

// ── STT response ──────────────────────────────────────────────────────────────

export interface SttResponse {
  text:      string;
  segments?: SttSegment[];
}

export interface SttSegment {
  startMs: number;
  endMs:   number;
  text:    string;
}

// ── Provider config ───────────────────────────────────────────────────────────

export interface SttProviderConfig {
  /** matches provider_configs.id in profile.db */
  id:       string;
  protocol: SttProtocol;
  apiKey:   string;
  baseUrl:  string;
}

// ── Adapter call arguments (constructed by SttClient, consumed by adapter) ───

/**
 * What an adapter actually receives. Routing fields (providerId) are stripped
 * by SttClient — adapters never need to know which provider they are.
 */
export interface SttAdapterCall {
  audio:        Uint8Array;
  mime:         string;
  model:        string;
  language?:    string;
  abortSignal?: AbortSignal;
}

// ── Health check ─────────────────────────────────────────────────────────────

export interface SttProviderHealth {
  providerId: string;
  protocol:   SttProtocol;
  ok:         boolean;
  reason?:    string;
}

export interface SttHealthResult {
  ok:        boolean;
  providers: SttProviderHealth[];
}

// ── Live probe ────────────────────────────────────────────────────────────────

export interface SttProbeResult {
  providerId: string;
  ok:         boolean;
  latencyMs?: number;
  /** Present when ok=false. */
  error?:     string;
}

// ── Adapter contract ──────────────────────────────────────────────────────────

export interface SttAdapter {
  readonly protocol: SttProtocol;
  /**
   * Transcribe audio. Implementations should honor `abortSignal` and surface
   * provider errors as thrown Errors with a descriptive message.
   */
  transcribe(call: SttAdapterCall): Promise<SttResponse>;
  /**
   * Live probe — verifies credentials with a lightweight real API call
   * (no audio upload required). Used by the settings page "Test connection"
   * button. Optional; SttClient.probe() returns ok=false when not implemented.
   */
  probe?(): Promise<Omit<SttProbeResult, 'providerId'>>;
}
