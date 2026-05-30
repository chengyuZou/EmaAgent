import type { SttAdapter, SttAdapterCall, SttProviderConfig, SttRequest, SttResponse, SttHealthResult } from './types.js';
import { OpenAiSttAdapter } from './adapters/openai-stt.js';

// ── SttClient Façade ────────────────────────────────────────────────────────
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
  private readonly adapters = new Map<string, SttAdapter>();
  private readonly configs  = new Map<string, SttProviderConfig>();

  constructor(
    configs: SttProviderConfig[],
    adapterOverrides?: ReadonlyMap<string, SttAdapter>,
  ) {
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
    this.configs.clear();
    this.adapters.clear();
    for (const config of configs) {
      this.configs.set(config.id, config);
      this.adapters.set(config.id, createAdapter(config));
    }
  }

  /** Transcribe audio. providerId + model are routing fields embedded in the request. */
  async transcribe(req: SttRequest): Promise<SttResponse> {
    const adapter = this.adapters.get(req.providerId);
    if (!adapter) {
      throw new Error(`stt/not_configured: provider "${req.providerId}" not registered`);
    }
    const call: SttAdapterCall = {
      audio:       req.audio,
      mime:        req.mime,
      model:       req.model,
      language:    req.language,
      abortSignal: req.abortSignal,
    };
    return adapter.transcribe(call);
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
