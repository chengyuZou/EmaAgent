import { OpenAiAdapter }         from './adapters/openai.js';
import { OpenAiResponsesAdapter } from './adapters/openai-responses.js';
import { AnthropicAdapter }       from './adapters/anthropic.js';
import { GeminiAdapter }          from './adapters/gemini.js';
import type { LlmAdapter }        from './adapters/base.js';
import { CircuitBreaker, CircuitOpenError } from './retry.js';
import { validateContentParts } from './validate.js';
import type { UnsupportedPart } from './validate.js';
import type {
  ProviderConfig,
  LlmRequest,
  LlmStreamChunk,
  LlmCompletion,
  LlmContentPart,
  ProbeResult,
  StopReason,
  AssistantBlock,
} from './types.js';
import type { LlmProtocol } from '@ema-agent/contracts';

// ── Internal factory ──────────────────────────────────────────────────────────

function createAdapter(config: ProviderConfig): LlmAdapter {
  switch (config.protocol) {
    case 'openai-llm':           return new OpenAiAdapter(config);
    case 'openai-responses-llm': return new OpenAiResponsesAdapter(config);
    case 'anthropic-llm':        return new AnthropicAdapter(config);
    case 'gemini-llm':           return new GeminiAdapter(config);
  }
}

function notConfigured(providerId: string): Error {
  const err = new Error('provider/not_configured');
  err.cause = providerId;
  return err;
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
  /** id → circuit breaker (per-provider failure isolation) */
  private readonly breakers = new Map<string, CircuitBreaker>();
  /** Test-only adapter replacements keyed by ProviderConfig.id. */
  private readonly adapterOverrides?: ReadonlyMap<string, LlmAdapter>;

  /**
   * @param configs           Provider configurations.
   * @param adapterOverrides  Pre-built adapters keyed by provider id. Ignored until
   *                          a matching ProviderConfig is registered.
   */
  constructor(
    configs: ProviderConfig[],
    adapterOverrides?: ReadonlyMap<string, LlmAdapter>,
  ) {
    this.adapterOverrides = adapterOverrides;
    for (const config of configs) {
      this.configs.set(config.id, config);
      this.adapters.set(config.id, this.createAdapterFor(config));
    }
  }

  private createAdapterFor(config: ProviderConfig): LlmAdapter {
    return this.adapterOverrides?.get(config.id) ?? createAdapter(config);
  }

  // ── Streaming ───────────────────────────────────────────────────────────────

  /**
   * Stream a completion from the specified provider instance.
   * Throws CircuitOpenError when the provider's circuit breaker is open.
   * Throws synchronously on unknown provider id.
   */
  stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    return this.guardedStream(request.providerId, () => {
      const adapter = this.adapters.get(request.providerId);
      if (!adapter) throw notConfigured(request.providerId);
      return adapter.stream(request, request.model);
    });
  }

  // ── Non-streaming ────────────────────────────────────────────────────────────

  /**
   * Collect the full completion into a single object.
   * Use for internal calls: compaction, emotion extraction, plan parsing.
   *
   * No built-in retry — callers (compaction, extraction) own their retry
   * policy. The circuit breaker on stream() protects against provider outages.
   *
   * Blocks are sorted by blockIndex so text/tool_use order is preserved even
   * though thinking_delta and tool_use_complete may arrive interleaved.
   */
  async complete(request: LlmRequest): Promise<LlmCompletion> {
    let stopReason: StopReason = 'end_turn';
    let inputTokens             = 0;
    let outputTokens            = 0;
    const textBufs             = new Map<number, string>();
    const thinkingBufs         = new Map<number, string>();
    const thinkingSignatureMap = new Map<number, string>();
    const toolUseMap           = new Map<number, AssistantBlock & { type: 'tool_use' }>();

    for await (const chunk of this.stream(request)) {
      switch (chunk.type) {
        case 'text_delta':
          textBufs.set(chunk.blockIndex, (textBufs.get(chunk.blockIndex) ?? '') + chunk.delta);
          break;
        case 'thinking_delta':
          thinkingBufs.set(chunk.blockIndex, (thinkingBufs.get(chunk.blockIndex) ?? '') + chunk.delta);
          break;
        case 'thinking_complete':
          thinkingSignatureMap.set(chunk.blockIndex, chunk.signature);
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

    const blockEntries: Array<[number, AssistantBlock]> = [];
    for (const [idx, text] of textBufs) {
      blockEntries.push([idx, { type: 'text', text }]);
    }
    for (const [idx, thinking] of thinkingBufs) {
      const signature = thinkingSignatureMap.get(idx);
      blockEntries.push([idx, { type: 'thinking', thinking, ...(signature ? { signature } : {}) }]);
    }
    for (const [idx, block] of toolUseMap) {
      blockEntries.push([idx, block]);
    }
    blockEntries.sort((a, b) => a[0] - b[0]);
    const blocks: AssistantBlock[] = blockEntries.map(([, block]) => block);

    return { blocks, stopReason, usage: { inputTokens, outputTokens } };
  }

  // ── Circuit breaker ──────────────────────────────────────────────────────────

  private breakerFor(providerId: string): CircuitBreaker {
    let cb = this.breakers.get(providerId);
    if (!cb) {
      cb = new CircuitBreaker();
      this.breakers.set(providerId, cb);
    }
    return cb;
  }

  /**
   * Wrap an adapter stream with circuit breaker gating.
   * - guard() before the call → throws CircuitOpenError if open.
   * - First successful chunk → breaker.success().
   * - Error thrown before any chunk → breaker.failure().
   */
  private async *guardedStream(
    breakerKey: string,
    start: () => AsyncIterable<LlmStreamChunk>,
  ): AsyncIterable<LlmStreamChunk> {
    const breaker = this.breakerFor(breakerKey);
    breaker.guard();

    let started = false;
    try {
      const stream = start();
      for await (const chunk of stream) {
        if (!started) {
          started = true;
          breaker.success();
        }
        yield chunk;
      }
    } catch (e) {
      if (!started) breaker.failure();
      // Re-throw CircuitOpenError so the caller can distinguish "breaker open"
      // from a real provider error. Don't count guard throws as failures.
      if (e instanceof CircuitOpenError) throw e;
      throw e;
    }
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
        { providerId, model, messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 },
        model,
      )) {
        if (chunk.type === 'done') break;
      }
      return { ok: true, latencyMs: Date.now() - start };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - start, error: (e as Error).message };
    }
  }

  getProtocol(providerId: string): LlmProtocol | undefined {
    return this.configs.get(providerId)?.protocol;
  }

  // ── Hot-reload ───────────────────────────────────────────────────────────────

  /** Add or replace a provider config at runtime (e.g. user updated API key). */
  upsertConfig(config: ProviderConfig): void {
    this.configs.set(config.id, config);
    this.adapters.set(config.id, this.createAdapterFor(config));
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

  /**
   * Check which content parts are incompatible with the given provider.
   * Looks up the provider's protocol internally — callers never need to know
   * which wire format the provider uses.
   * Returns an empty array when everything is compatible.
   */
  warnUnsupportedParts(providerId: string, parts: LlmContentPart[]): UnsupportedPart[] {
    const protocol = this.configs.get(providerId)?.protocol;
    if (!protocol) throw notConfigured(providerId);
    return validateContentParts(parts, protocol);
  }
}
