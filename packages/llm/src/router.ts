import { OpenAiAdapter }    from './adapters/openai.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { GeminiAdapter }    from './adapters/gemini.js';
import type { LlmAdapter }  from './adapters/base.js';
import { withRetry }        from './retry.js';
import type {
  ProviderConfig,
  LlmRequest,
  LlmStreamChunk,
  LlmCompletion,
  ProbeResult,
  StopReason,
  AssistantBlock,
} from './types.js';

// ── Internal factory ──────────────────────────────────────────────────────────

function createAdapter(config: ProviderConfig): LlmAdapter {
  switch (config.protocol) {
    case 'openai-llm':    return new OpenAiAdapter(config);
    case 'anthropic-llm': return new AnthropicAdapter(config);
    case 'gemini-llm':    return new GeminiAdapter(config);
  }
}

// ── LlmRouter ─────────────────────────────────────────────────────────────────

/**
 * Single Façade for all LLM access.
 *
 * Keyed by ProviderConfig.id (the provider_configs UUID from the DB), NOT by
 * protocol — multiple providers can share the same protocol (e.g. DeepSeek +
 * SiliconFlow are both 'openai-llm') and each deserves its own adapter entry.
 */
export class LlmRouter {
  /** id → adapter instance */
  private readonly adapters = new Map<string, LlmAdapter>();
  /** id → config (kept for hot-reload and probe) */
  private readonly configs  = new Map<string, ProviderConfig>();

  /**
   * @param configs           Provider configurations.
   * @param adapterOverrides  Pre-built adapters keyed by provider id (tests inject mocks here).
   */
  constructor(
    configs: ProviderConfig[],
    adapterOverrides?: ReadonlyMap<string, LlmAdapter>,
  ) {
    for (const config of configs) {
      this.configs.set(config.id, config);
      const override = adapterOverrides?.get(config.id);
      this.adapters.set(config.id, override ?? createAdapter(config));
    }
    // Allow overrides for provider ids that have no ProviderConfig (pure mock injection)
    if (adapterOverrides) {
      for (const [id, adapter] of adapterOverrides) {
        if (!this.adapters.has(id)) this.adapters.set(id, adapter);
      }
    }
  }

  // ── Streaming ───────────────────────────────────────────────────────────────

  /** Stream a completion from the specified provider instance. Throws synchronously on unknown id. */
  stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const adapter = this.adapters.get(request.providerId);
    if (!adapter) {
      const err = new Error('provider/not_configured');
      err.cause = request.providerId;
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
  /**
   * Collect the full completion into a single object.
   * Wraps stream() with exponential-backoff retry (429/5xx → up to 3 attempts).
   * Use for internal calls: compaction, emotion extraction, plan parsing.
   *
   * Blocks are sorted by blockIndex so text/tool_use order is preserved even
   * though thinking_delta and tool_use_complete may arrive interleaved.
   */
  async complete(request: LlmRequest): Promise<LlmCompletion> {
    return withRetry(async () => {
      let stopReason: StopReason  = 'end_turn';
      let inputTokens             = 0;
      let outputTokens            = 0;

      // Accumulate by blockIndex so we can sort at the end
      const textBufs     = new Map<number, string>();
      const thinkingBufs = new Map<number, string>();
      // tool_use_complete arrives once per block with final args
      const toolUseMap   = new Map<number, AssistantBlock & { type: 'tool_use' }>();

      for await (const chunk of this.stream(request)) {
        switch (chunk.type) {
          case 'text_delta':
            textBufs.set(chunk.blockIndex, (textBufs.get(chunk.blockIndex) ?? '') + chunk.delta);
            break;
          case 'thinking_delta':
            thinkingBufs.set(chunk.blockIndex, (thinkingBufs.get(chunk.blockIndex) ?? '') + chunk.delta);
            break;
          case 'tool_use_complete':
            toolUseMap.set(chunk.blockIndex, { type: 'tool_use', id: chunk.callId, name: chunk.name, args: chunk.args });
            break;
          case 'usage':
            inputTokens  = chunk.inputTokens;
            outputTokens = chunk.outputTokens;
            break;
          case 'done':
            stopReason = chunk.stopReason;
            break;
        }
      }

      // Merge all block maps, sort by blockIndex to preserve original order
      const blockEntries: Array<[number, AssistantBlock]> = [];
      for (const [idx, text] of textBufs)     blockEntries.push([idx, { type: 'text', text }]);
      for (const [idx, thinking] of thinkingBufs) blockEntries.push([idx, { type: 'thinking', thinking }]);
      for (const [idx, block] of toolUseMap)  blockEntries.push([idx, block]);
      blockEntries.sort((a, b) => a[0] - b[0]);
      const blocks: AssistantBlock[] = blockEntries.map(([, block]) => block);

      return { blocks, stopReason, usage: { inputTokens, outputTokens } };
    });
  }

  // ── Health check ─────────────────────────────────────────────────────────────

  /**
   * Verify a provider endpoint is reachable and the API key is valid.
   * Used by the settings page when the user saves a new key.
   *
   * @param providerId  The provider_configs.id to probe.
   * @param model       A model known to exist on this provider.
   */
  async probe(providerId: string, model: string): Promise<ProbeResult> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) return { ok: false, error: `provider/not_configured: no config registered for "${providerId}"` };

    const start = Date.now();
    try {
      for await (const chunk of adapter.stream(
        { providerId, model, messages: [{ role: 'user', content: 'hi' }], maxTokens: 1 },
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
    this.configs.set(config.id, config);
    this.adapters.set(config.id, createAdapter(config));
  }

  removeConfig(providerId: string): void {
    this.configs.delete(providerId);
    this.adapters.delete(providerId);
  }

  /** Returns the first registered config id, or undefined if none. Used as a last-resort fallback. */
  firstProviderId(): string | undefined {
    return this.configs.keys().next().value;
  }

  /** Returns the defaultModel for a given provider id, or undefined. */
  defaultModelFor(providerId: string): string | undefined {
    return this.configs.get(providerId)?.defaultModel;
  }
}
