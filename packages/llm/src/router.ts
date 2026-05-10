import { OpenAiAdapter }    from './adapters/openai.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { GeminiAdapter }    from './adapters/gemini.js';
import type { LlmAdapter }  from './adapters/base.js';
import type { ProviderConfig, LlmProvider, LlmRequest, LlmStreamChunk } from './types.js';

// ── Internal factory ──────────────────────────────────────────────────────────

function createAdapter(config: ProviderConfig): LlmAdapter {
  switch (config.provider) {
    case 'openai':
    case 'openai-compat':
      return new OpenAiAdapter(config);
    case 'anthropic':
      return new AnthropicAdapter(config);
    case 'gemini':
      return new GeminiAdapter(config);
  }
}

// ── LlmRouter ─────────────────────────────────────────────────────────────────

/**
 * Single Façade for all LLM access.
 * One ProviderConfig per provider type — keyed by `provider` field.
 */
export class LlmRouter {
  private readonly adapters = new Map<LlmProvider, LlmAdapter>();

  /**
   * @param configs         Provider configurations — one per provider type.
   * @param adapterOverrides  Pre-built adapters keyed by provider type.
   *                          Used in tests to inject mocks without real API keys.
   */
  constructor(
    configs: ProviderConfig[],
    adapterOverrides?: ReadonlyMap<LlmProvider, LlmAdapter>,
  ) {
    for (const config of configs) {
      const override = adapterOverrides?.get(config.provider);
      this.adapters.set(config.provider, override ?? createAdapter(config));
    }
    if (adapterOverrides) {
      for (const [provider, adapter] of adapterOverrides) {
        if (!this.adapters.has(provider)) {
          this.adapters.set(provider, adapter);
        }
      }
    }
  }

  /** Stream a completion from the specified provider. */
  stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const adapter = this.adapters.get(request.provider);
    if (!adapter) {
      throw new Error(`unknown_provider: no config registered for "${request.provider}"`);
    }
    return adapter.stream(request, request.model);
  }

  /** Add or replace a provider config at runtime (e.g. user updated API key). */
  upsertConfig(config: ProviderConfig): void {
    this.adapters.set(config.provider, createAdapter(config));
  }

  removeConfig(provider: LlmProvider): void {
    this.adapters.delete(provider);
  }
}
