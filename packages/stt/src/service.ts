import type { SttAdapter, SttAdapterCall, SttProviderConfig, SttRequest, SttResponse, SttHealthResult, SttProbeResult } from './types.js';
import { OpenAiSttAdapter } from './adapters/openai-stt.js';
import { isSttError, SttError } from './errors.js';
import { createSttRequestScope } from './request-scope.js';
import type { SttLimits } from './types.js';

const DEFAULT_LIMITS: Readonly<SttLimits> = {
  maxAudioBytes: 25 * 1024 * 1024,
  timeoutMs: 120_000,
};

// ── SttClient Facade ────────────────────────────────────────────────────────
//
// Symmetric to TtsClient / LlmRouter:
//   - Holds provider configs + adapters, keyed by provider_configs.id.
//   - Routing (which providerId + model to use) is always decided by the
//     caller (route handler reads model_bindings.get('stt')).
//   - No binding stored here — binding is a business-layer concern.

function createAdapter(cfg: SttProviderConfig): SttAdapter {
  switch (cfg.protocol) {
    case 'openai-stt': return new OpenAiSttAdapter(cfg);
  }
}

export class SttClient {
  private adapters = new Map<string, SttAdapter>();
  private configs  = new Map<string, SttProviderConfig>();
  private readonly limits: Readonly<SttLimits>;

  constructor(
    configs: SttProviderConfig[],
    adapterOverrides?: ReadonlyMap<string, SttAdapter>,
    limits: Partial<SttLimits> = {},
  ) {
    this.limits = validateLimits({ ...DEFAULT_LIMITS, ...limits });
    for (const config of configs) {
      this.configs.set(config.id, config);
      const override = adapterOverrides?.get(config.id);
      this.adapters.set(config.id, override ?? createAdapter(config));
    }
    if (adapterOverrides) {
      for (const [id, adapter] of adapterOverrides) {
        if (!this.adapters.has(id)) this.adapters.set(id, adapter);
      }
    }
  }

  /** True when at least one STT provider is registered. */
  isAvailable(): boolean {
    return this.adapters.size > 0;
  }

  /** Health check — verifies that at least one STT provider is configured. V1 is config-only, no live API call. */
  healthCheck(): SttHealthResult {
    const providers = [...this.configs.entries()].map(([id, cfg]) => ({
      providerId: id,
      protocol:   cfg.protocol,
      ok:         this.adapters.has(id),
    }));
    return {
      ok: providers.length > 0 && providers.every((p) => p.ok),
      providers,
    };
  }

  /** Hot-reload: replace all provider configs atomically. */
  reload(configs: SttProviderConfig[]): void {
    const nextAdapters = new Map<string, SttAdapter>();
    const nextConfigs = new Map<string, SttProviderConfig>();
    for (const config of configs) {
      nextConfigs.set(config.id, config);
      nextAdapters.set(config.id, createAdapter(config));
    }
    this.configs = nextConfigs;
    this.adapters = nextAdapters;
  }

  /**
   * Live probe — makes a real API call to verify credentials.
   * Symmetric with LlmRouter.probe() / TtsClient equivalent.
   *
   * Delegates to adapter.probe() when available; falls back to
   * ok=false + "probe not supported" when the adapter has no probe
   * (should not happen in V1 since openai-stt implements it).
   */
  async probe(providerId: string): Promise<SttProbeResult> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      return { providerId, ok: false, error: `provider "${providerId}" not registered` };
    }
    if (!adapter.probe) {
      return { providerId, ok: false, error: 'probe not supported by this adapter' };
    }
    const result = await adapter.probe();
    return { providerId, ...result };
  }

  /** Transcribe audio. providerId + model are routing fields embedded in the request. */
  async transcribe(req: SttRequest): Promise<SttResponse> {
    validateRequest(req, this.limits);
    const adapter = this.adapters.get(req.providerId);
    if (!adapter) {
      throw new SttError(
        'not_configured',
        `stt/not_configured: provider "${req.providerId}" not registered`,
      );
    }
    const scope = createSttRequestScope(req.abortSignal, this.limits.timeoutMs);
    const call: SttAdapterCall = {
      audio:       req.audio,
      mime:        req.mime,
      model:       req.model,
      language:    req.language,
      abortSignal: scope.signal,
    };
    try {
      const response = await adapter.transcribe(call);
      if (scope.signal.aborted) throw scope.signal.reason;
      return response;
    } catch (error) {
      if (isSttError(error)) throw error;
      if (scope.signal.aborted && isSttError(scope.signal.reason)) {
        throw scope.signal.reason;
      }
      throw new SttError('provider_failed', 'STT provider request failed', {
        cause: error,
        retryable: true,
      });
    } finally {
      scope.dispose();
    }
  }

  /** Hot-reload: add or replace a provider config. */
  upsertConfig(config: SttProviderConfig): void {
    this.configs.set(config.id, config);
    this.adapters.set(config.id, createAdapter(config));
  }

  removeConfig(id: string): void {
    this.configs.delete(id);
    this.adapters.delete(id);
  }

  firstProviderId(): string | undefined {
    return this.configs.keys().next().value;
  }
}

function validateLimits(limits: SttLimits): Readonly<SttLimits> {
  if (!Number.isSafeInteger(limits.maxAudioBytes) || limits.maxAudioBytes <= 0) {
    throw new TypeError('STT maxAudioBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0) {
    throw new TypeError('STT timeoutMs must be a positive safe integer');
  }
  return Object.freeze(limits);
}

function validateRequest(req: SttRequest, limits: Readonly<SttLimits>): void {
  if (!req.providerId.trim() || !req.model.trim() || !req.mime.trim()) {
    throw new SttError('invalid_request', 'providerId, model and mime are required');
  }
  if (req.audio.byteLength === 0) {
    throw new SttError('invalid_request', 'audio must not be empty');
  }
  if (req.audio.byteLength > limits.maxAudioBytes) {
    throw new SttError(
      'payload_too_large',
      `audio payload is ${req.audio.byteLength} bytes; limit is ${limits.maxAudioBytes} bytes`,
    );
  }
}
