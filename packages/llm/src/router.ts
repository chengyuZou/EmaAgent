import { OpenAiAdapter }         from './adapters/openai.js';
import { OpenAiResponsesAdapter } from './adapters/openai-responses.js';
import { AnthropicAdapter }       from './adapters/anthropic.js';
import { GeminiAdapter }          from './adapters/gemini.js';
import type { LlmAdapter }        from './adapters/base.js';
import { sleep, httpStatus, isRetryable, rethrowAs } from './retry.js';
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

  /** Stream a completion from the specified provider instance. Throws synchronously on unknown id. */
  stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    if (!this.configs.has(request.providerId)) {
      throw notConfigured(request.providerId);
    }
    const adapter = this.adapters.get(request.providerId);
    if (!adapter) {
      throw notConfigured(request.providerId);
    }
    return adapter.stream(request, request.model);
  }

  // ── Non-streaming ────────────────────────────────────────────────────────────

  /**
   * Collect the full completion into a single object.
   * Use for internal calls: compaction, emotion extraction, plan parsing.
   *
   * Retry policy:
   *   - Only retries when the connection fails BEFORE any chunk arrives
   *     (401/429/5xx thrown by the adapter before the first yield).
   *   - Never retries a mid-stream failure: if we already received tokens,
   *     retrying would double the token cost and might produce different output.
   *
   * Blocks are sorted by blockIndex so text/tool_use order is preserved even
   * though thinking_delta and tool_use_complete may arrive interleaved.
   */
  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const MAX_ATTEMPTS = 3;
    const BASE_DELAY_MS = 1_000;
    let lastErr: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // Reset accumulation state for each attempt.
      let stopReason: StopReason = 'end_turn';
      let inputTokens             = 0;
      let outputTokens            = 0;
      const textBufs             = new Map<number, string>();
      const thinkingBufs         = new Map<number, string>();
      const thinkingSignatureMap = new Map<number, string>();
      const toolUseMap           = new Map<number, AssistantBlock & { type: 'tool_use' }>();

      // Tracks whether the provider sent at least one chunk.
      // When true, the HTTP connection succeeded and tokens are already in flight —
      // retrying would double-charge the caller, so we propagate the error directly.
      let hasStartedStreaming = false;

      try {
        for await (const chunk of this.stream(request)) {
          hasStartedStreaming = true;
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

        // Stream completed normally — build result.
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

      } catch (e) {
        lastErr = e;

        // Mid-stream failure: tokens were already consumed, no retry.
        if (hasStartedStreaming) throw e;

        // Connection failure: classify and maybe retry.
        const s = httpStatus(e);
        if (s === 401 || s === 403) rethrowAs('auth/api_key_invalid',     e);
        if (s === 413)              rethrowAs('provider/context_too_long', e);
        if (!isRetryable(e) || attempt === MAX_ATTEMPTS - 1) throw e;

        await sleep(BASE_DELAY_MS * 2 ** attempt);
      }
    }

    throw lastErr;
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
   * Returns the user-configured context window for a provider if set in
   * `ProviderConfig.contextWindow`. Callers should prefer this over catalog
   * lookup for non-static / custom models (Ollama, OpenRouter, etc.).
   */
  configuredContextWindowFor(providerId: string): number | undefined {
    const cw = this.configs.get(providerId)?.contextWindow;
    return cw && cw > 0 ? cw : undefined;
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
