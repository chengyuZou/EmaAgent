import { OpenAiAdapter }    from './adapters/openai.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { GeminiAdapter }    from './adapters/gemini.js';
import type { LlmAdapter }  from './adapters/base.js';
import type { ProviderConfig, LlmRequest, LlmStreamChunk } from './types.js';

// ── Internal factory ──────────────────────────────────────────────────────────

function createAdapter(config: ProviderConfig): LlmAdapter {
  switch (config.provider) {
    case 'openai':
      return new OpenAiAdapter(config.apiKey);
    case 'openai-compat':
      // Same adapter — just point at a different base URL (Ollama, LM Studio, …).
      return new OpenAiAdapter(config.apiKey, config.baseUrl);
    case 'anthropic':
      return new AnthropicAdapter(config.apiKey, config.baseUrl);
    case 'gemini':
      return new GeminiAdapter(config.apiKey);
  }
}

// ── LlmRouter ─────────────────────────────────────────────────────────────────

/**
 * Single Façade for all LLM access.
 *
 * Routing: model strings use the format "<providerId>/<model-name>".
 *   "openai-main/gpt-4o"              → OpenAI adapter, model "gpt-4o"
 *   "anthropic-main/claude-opus-4-5"  → Anthropic adapter, model "claude-opus-4-5"
 *   "local-ollama/llama3.2"           → OpenAI-compat adapter, model "llama3.2"
 *
 * The `providerId` must match the `id` field of a ProviderConfig passed at construction.
 */
export class LlmRouter {
  private readonly adapters = new Map<string, LlmAdapter>();

  /**
   * @param configs         Provider configurations (from DB / settings).
   * @param adapterOverrides  Pre-built adapter instances keyed by providerId.
   *                          Used in tests to inject mocks without real API keys.
   */
  constructor(
    configs: ProviderConfig[],
    adapterOverrides?: ReadonlyMap<string, LlmAdapter>,
  ) {
    for (const config of configs) {
      const override = adapterOverrides?.get(config.id);
      this.adapters.set(config.id, override ?? createAdapter(config));
    }
    // Also register overrides that have no matching config (pure test stubs).
    if (adapterOverrides) {
      for (const [id, adapter] of adapterOverrides) {
        if (!this.adapters.has(id)) {
          this.adapters.set(id, adapter);
        }
      }
    }
  }

  /**
   * Stream a completion.
   *
   * Throws synchronously for configuration errors (unknown provider, bad model
   * string) so the engine can fail the turn immediately without entering the
   * async loop.
   */
  stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const slashIdx = request.model.indexOf('/');
    if (slashIdx === -1) {
      throw new Error(
        `invalid_model: model must be "<providerId>/<model-name>", got "${request.model}"`,
      );
    }

    const providerId = request.model.slice(0, slashIdx);
    const modelName  = request.model.slice(slashIdx + 1);

    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw new Error(`unknown_provider: no provider configured for "${providerId}"`);
    }

    return adapter.stream(request, modelName);
  }

  // ── Hot-reload ───────────────────────────────────────────────────────────────

  /** Add or replace a provider config (e.g. user updated API key in settings). */
  upsertConfig(config: ProviderConfig): void {
    this.adapters.set(config.id, createAdapter(config));
  }

  /** Remove a provider. Subsequent stream() calls for that providerId will throw. */
  removeConfig(id: string): void {
    this.adapters.delete(id);
  }
}
