import { OpenAiAdapter }         from './adapters/openai.js';
import { OpenAiResponsesAdapter } from './adapters/openai-responses.js';
import { AnthropicAdapter }       from './adapters/anthropic.js';
import { GeminiAdapter }          from './adapters/gemini.js';
import type { LlmAdapter }        from './adapters/base.js';
import { LlmStreamRuntime } from './stream-runtime.js';
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
  LlmUsage,
} from './types.js';
import type { LlmProtocol } from '@ema-agent/contracts';
import type { ModelsDevCatalog } from './models-dev-catalog.js';
import { normalizeToolDefinitions } from './prompt-cache.js';

// ── 内部工厂 ──────────────────────────────────────────────────────────

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

// ── LlmRouter ─────────────────────────────────────────────────────────

/**
 * 所有 LLM 访问的单一 Facade。
 *
 * 以 ProviderConfig.id(DB 里 provider_configs 的 UUID)为 key,而非 protocol -
 * 多个 provider 可共享同一 protocol(如 DeepSeek + SiliconFlow 都是 'openai-llm'),
 * 每个都该有独立的 adapter 条目。
 */
export class LlmRouter {
  /** id -> adapter 实例 */
  private readonly adapters = new Map<string, LlmAdapter>();
  /** id -> config(保留用于热重载和 probe) */
  private readonly configs  = new Map<string, ProviderConfig>();
  /** 流生命周期、重试边界与 per-provider 熔断状态。 */
  private readonly streamRuntime = new LlmStreamRuntime();
  /** 仅测试用的 adapter 替换,以 ProviderConfig.id 为 key。 */
  private readonly adapterOverrides?: ReadonlyMap<string, LlmAdapter>;

  /**
   * @param configs           Provider 配置。
   * @param adapterOverrides  预构建的 adapter,以 provider id 为 key。
   *                          在匹配的 ProviderConfig 注册前被忽略。
   */
  constructor(
    configs: ProviderConfig[],
    adapterOverrides?: ReadonlyMap<string, LlmAdapter>,
    private readonly catalog?: ModelsDevCatalog,
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

  // ── 流式 ───────────────────────────────────────────────

  /**
   * 从指定 provider 实例流式产出 completion。
   * provider 熔断器 open 时抛 CircuitOpenError。
   * 未知 provider id 时同步抛错。
   */
  stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const catalogEnriched: LlmRequest = this.catalog ? {
      ...request,
      supportsReasoning: request.supportsReasoning ?? this.catalog.hasReasoning(request.model),
      maxTokens:         request.maxTokens         ?? this.catalog.maxOutputOf(request.model),
    } : request;
    const enriched: LlmRequest = catalogEnriched.tools ? {
      ...catalogEnriched,
      tools: normalizeToolDefinitions(catalogEnriched.tools),
    } : catalogEnriched;
    // Façade 必须同步拒绝未知 Provider，Engine 才能在创建异步迭代器时 fail-fast。
    const adapter = this.adapters.get(enriched.providerId);
    if (!adapter) throw notConfigured(enriched.providerId);
    return this.streamRuntime.stream(
      enriched.providerId,
      () => adapter.stream(enriched, enriched.model),
      enriched.signal,
    );
  }

  // ── 非流式 ────────────────────────────────────────────────────

  /**
   * 把完整 completion 收集成单个对象。
   * 用于内部调用:compaction、emotion 抽取、plan 解析。
   *
   * 无内置重试 - 调用方(compaction、extraction)自管重试策略。
   * stream() 上的熔断器防护 provider 故障。
   *
   * blocks 按 blockIndex 排序,这样即使 thinking_delta 与 tool_use_complete
   * 交错到达,text/tool_use 顺序也得以保留。
   */
  async complete(request: LlmRequest): Promise<LlmCompletion> {
    let stopReason: StopReason = 'end_turn';
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
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
          usage = {
            inputTokens: chunk.inputTokens,
            outputTokens: chunk.outputTokens,
            ...(chunk.cacheReadInputTokens !== undefined
              ? { cacheReadInputTokens: chunk.cacheReadInputTokens }
              : {}),
            ...(chunk.cacheWriteInputTokens !== undefined
              ? { cacheWriteInputTokens: chunk.cacheWriteInputTokens }
              : {}),
            ...(chunk.cacheHitRate !== undefined ? { cacheHitRate: chunk.cacheHitRate } : {}),
          };
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

    return { blocks, stopReason, usage };
  }

  // ── 健康检查 ─────────────────────────────────────────────

  /**
   * 验证 provider endpoint 可达且 API key 有效。
   * 用户在设置页保存新 key 时使用。
   *
   * @param providerId  待 probe 的 provider_configs.id。
   * @param model       该 provider 上已知存在的模型。
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

  // ── 热重载 ───────────────────────────────────────────────

  /** 运行时新增或替换 provider config(如用户更新了 API key)。 */
  upsertConfig(config: ProviderConfig): void {
    this.configs.set(config.id, config);
    this.adapters.set(config.id, this.createAdapterFor(config));
    this.streamRuntime.reset(config.id);
  }

  removeConfig(providerId: string): void {
    this.configs.delete(providerId);
    this.adapters.delete(providerId);
    this.streamRuntime.reset(providerId);
  }

  /** 返回首个已注册 config id,无则 undefined。用作最后兜底。 */
  firstProviderId(): string | undefined {
    return this.configs.keys().next().value;
  }

  /** 返回给定 provider id 的 defaultModel,无则 undefined。 */
  defaultModelFor(providerId: string): string | undefined {
    return this.configs.get(providerId)?.defaultModel;
  }

  /**
   * 检查哪些 content part 与给定 provider 不兼容。
   * 内部查 provider 的 protocol - 调用方无需知道 provider 用哪种线路格式。
   * 全部兼容时返回空数组。
   */
  warnUnsupportedParts(providerId: string, parts: LlmContentPart[]): UnsupportedPart[] {
    const protocol = this.configs.get(providerId)?.protocol;
    if (!protocol) throw notConfigured(providerId);
    return validateContentParts(parts, protocol);
  }
}
