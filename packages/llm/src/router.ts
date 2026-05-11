import type { ErrorCode } from '@ema-agent/contracts';
import { OpenAiAdapter }    from './adapters/openai.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { GeminiAdapter }    from './adapters/gemini.js';
import type { LlmAdapter }  from './adapters/base.js';
import { withRetry }        from './retry.js';
import type {
  ProviderConfig,
  LlmProvider,
  LlmRequest,
  LlmStreamChunk,
  LlmToolCall,
  LlmCompletion,
  ProbeResult,
  StopReason,
} from './types.js';

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
  private readonly configs  = new Map<LlmProvider, ProviderConfig>();

  /**
   * @param configs           Provider configurations — one per provider type.
   * @param adapterOverrides  Pre-built adapters keyed by provider (tests inject mocks here).
   */
  constructor(
    configs: ProviderConfig[],
    adapterOverrides?: ReadonlyMap<LlmProvider, LlmAdapter>,
  ) {
    for (const config of configs) {
      this.configs.set(config.provider, config);
      const override = adapterOverrides?.get(config.provider);
      this.adapters.set(config.provider, override ?? createAdapter(config));
    }
    // Allow overrides for providers that have no ProviderConfig (pure mock injection)
    if (adapterOverrides) {
      for (const [provider, adapter] of adapterOverrides) {
        if (!this.adapters.has(provider)) this.adapters.set(provider, adapter);
      }
    }
  }

  // ── Streaming ───────────────────────────────────────────────────────────────

  /** Stream a completion from the specified provider. Throws synchronously on unknown provider. */
  stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const adapter = this.adapters.get(request.provider);
    if (!adapter) {
      const err = new Error('provider/not_configured');
      err.cause = request.provider;
      throw err;
    }
    return adapter.stream(request, request.model);
  }

  // ── Non-streaming ────────────────────────────────────────────────────────────

  /**
   * Collect the full completion into a single object.
   * Wraps stream() with exponential-backoff retry (429/5xx → up to 3 attempts).
   * Use for internal calls: compaction, emotion extraction, plan parsing.
   */
  async complete(request: LlmRequest): Promise<LlmCompletion> {
    return withRetry(async () => {
      let text                    = '';
      let stopReason: StopReason  = 'end_turn';
      let inputTokens             = 0;
      let outputTokens            = 0;
      const toolCalls: LlmToolCall[] = [];

      for await (const chunk of this.stream(request)) {
        switch (chunk.type) {
          case 'text_delta':        text         += chunk.delta; break;
          case 'tool_use_complete': toolCalls.push({ id: chunk.callId, name: chunk.name, args: chunk.args }); break;
          case 'usage':             inputTokens   = chunk.inputTokens; outputTokens = chunk.outputTokens; break;
          case 'done':              stopReason    = chunk.stopReason; break;
        }
      }

      return { text: text || null, toolCalls, stopReason, usage: { inputTokens, outputTokens } };
    });
  }

  // ── Health check ─────────────────────────────────────────────────────────────

  /**
   * Verify a provider endpoint is reachable and the API key is valid.
   * Used by the settings page when the user saves a new key.
   */
  async probe(provider: LlmProvider, model: string): Promise<ProbeResult> {
    const adapter = this.adapters.get(provider);
    if (!adapter) return { ok: false, error: `provider/not_configured: no config registered for "${provider}"` };

    const start = Date.now();
    try {
      for await (const chunk of adapter.stream(
        { provider, model, messages: [{ role: 'user', content: 'hi' }], maxTokens: 1 },
        model,
      )) {
        if (chunk.type === 'done') break;
      }
      return { ok: true, latencyMs: Date.now() - start };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - start, error: (e as Error).message };
    }
  }

  // ── Hot-reload ───────────────────────────────────────────────────────────────

  /** Add or replace a provider config at runtime (e.g. user updated API key). */
  upsertConfig(config: ProviderConfig): void {
    this.configs.set(config.provider, config);
    this.adapters.set(config.provider, createAdapter(config));
  }

  removeConfig(provider: LlmProvider): void {
    this.configs.delete(provider);
    this.adapters.delete(provider);
  }
}
