// 运行语言模型调用，并协调 Provider 快照、请求准备、流生命周期与用量记录。
import { randomUUID } from 'node:crypto';
import { OpenAiAdapter }         from './adapters/openai.js';
import { OpenAiResponsesAdapter } from './adapters/openaiResponses.js';
import { AnthropicAdapter }       from './adapters/anthropic.js';
import { GeminiAdapter }          from './adapters/gemini.js';
import type { LlmAdapter }        from './adapters/base.js';
import { LlmStreamRuntime } from './streamRuntime.js';
import { validateContentParts } from './validate.js';
import type { UnsupportedPart } from './validate.js';
import type {
  ProviderConfig,
  Message,
  LlmRequest,
  LlmStreamChunk,
  LlmCompletion,
  LlmContentPart,
  ProbeResult,
  StopReason,
  AssistantBlock,
  LlmTokenUsage,
} from './types.js';
import type { LanguageModel } from './languageModel.js';
import type { UsageRecord, UsageRecorder } from '@ema-agent/usage';
import type { LlmProtocol } from '@ema-agent/provider';
import type { ModelsDevCatalog } from './modelsDevCatalog.js';
import {
  capabilitiesFromCatalog,
  capabilitiesFromManualVision,
  unknownModelCapabilities,
  type ModelCapabilitySnapshot,
} from './modelCapabilities.js';
import {
  prepareHistoricalMessageView,
  validateCurrentContent,
  type CompatibleMessageView,
} from './messageCompatibility.js';
import { LlmModelCapabilityError } from './errors.js';
import { createCompatibilityRecovery } from './compatibilityRecovery.js';
import { LlmRequestPreparer } from './llmRequestPreparer.js';
import { ProviderRuntimeRegistry } from './providerRuntimeRegistry.js';

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

// ── LanguageModelRuntime ───────────────────────────────────────────────

/**
 * 语言模型调用的运行时实现。
 *
 * 以 ProviderConfig.id(DB 里 provider_configs 的 UUID)为 key,而非 protocol -
 * 多个 provider 可共享同一 protocol(如 DeepSeek + SiliconFlow 都是 'openai-llm'),
 * 每个都该有独立的 adapter 条目。
 */
export class LanguageModelRuntime implements LanguageModel {
  /** Provider 配置与 Adapter 作为同一快照换代，单次调用不会读到混合版本。 */
  private readonly providerRegistry: ProviderRuntimeRegistry;
  private readonly requestPreparer: LlmRequestPreparer;
  /** 流生命周期、重试边界与 per-provider 熔断状态。 */
  private readonly streamRuntime = new LlmStreamRuntime();
  /** 仅测试用的 adapter 替换,以 ProviderConfig.id 为 key。 */
  private readonly adapterOverrides?: ReadonlyMap<string, LlmAdapter>;
  private readonly supportsManualImageInput?: (providerId: string, model: string) => boolean;
  private readonly usageRecorder?: UsageRecorder;
  private readonly onUsageRecordError?: (error: unknown, record: UsageRecord) => void;

  /**
   * @param configs           Provider 配置。
   * @param adapterOverrides  预构建的 adapter,以 provider id 为 key。
   *                          在匹配的 ProviderConfig 注册前被忽略。
   */
  constructor(
    configs: ProviderConfig[],
    adapterOverrides?: ReadonlyMap<string, LlmAdapter>,
    private readonly catalog?: ModelsDevCatalog,
    options: {
      supportsManualImageInput?: (providerId: string, model: string) => boolean;
      usageRecorder?: UsageRecorder;
      onUsageRecordError?: (error: unknown, record: UsageRecord) => void;
    } = {},
  ) {
    this.adapterOverrides = adapterOverrides;
    this.supportsManualImageInput = options.supportsManualImageInput;
    this.usageRecorder = options.usageRecorder;
    this.onUsageRecordError = options.onUsageRecordError;
    this.providerRegistry = new ProviderRuntimeRegistry(
      configs,
      (config) => this.createAdapterFor(config),
    );
    this.requestPreparer = new LlmRequestPreparer({
      capabilitiesFor: (providerId, model) => this.capabilitiesFor(providerId, model),
    });
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
    // 公共入口必须同步拒绝未知 Provider，Engine 创建异步迭代器时即可 fail-fast。
    const entry = this.providerRegistry.get(request.providerId);
    if (!entry) throw notConfigured(request.providerId);
    const prepared = this.requestPreparer.prepare(request, entry.config.protocol);
    const recovery = createCompatibilityRecovery(entry.adapter, prepared);
    const source = this.streamRuntime.stream(
      prepared.providerId,
      recovery.start,
      prepared.signal,
      recovery.recover,
    );
    return this.recordStreamUsage(prepared, source);
  }

  /** 包装统一流，不让观测数据写入失败破坏模型主链路。 */
  private async *recordStreamUsage(
    request: LlmRequest,
    source: AsyncIterable<LlmStreamChunk>,
  ): AsyncIterable<LlmStreamChunk> {
    const startedAt = Date.now();
    let usage: LlmTokenUsage | undefined;
    let completed = false;
    let errorCode: string | null = null;

    try {
      for await (const chunk of source) {
        if (chunk.type === 'usage') usage = chunk;
        if (chunk.type === 'done') completed = true;
        yield chunk;
      }
    } catch (error) {
      errorCode = usageErrorCode(error);
      throw error;
    } finally {
      const record: UsageRecord = {
        id: request.usageContext?.callId ?? randomUUID(),
        sessionId: request.usageContext?.sessionId ?? null,
        turnId: request.usageContext?.turnId ?? null,
        providerId: request.providerId,
        modelId: request.model,
        capability: 'llm',
        status: completed ? 'completed' : 'failed',
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        cacheReadInputTokens: usage?.cacheReadInputTokens ?? null,
        cacheWriteInputTokens: usage?.cacheWriteInputTokens ?? null,
        quantity: null,
        unit: null,
        costUsd: null,
        durationMs: Math.max(0, Date.now() - startedAt),
        errorCode: completed ? null : errorCode ?? 'llm/stream_incomplete',
        createdAt: startedAt,
      };
      try {
        this.usageRecorder?.record(record);
      } catch (error) {
        try {
          this.onUsageRecordError?.(error, record);
        } catch {
          // 诊断回调也不能反向破坏已经成功的模型流。
        }
      }
    }
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
    let usage: LlmTokenUsage = { inputTokens: 0, outputTokens: 0 };
    const textBufs             = new Map<number, string>();
    const thinkingBufs         = new Map<number, string>();
    const thinkingSignatureMap = new Map<number, string>();
    const toolUseMap           = new Map<number, AssistantBlock & { type: 'tool_use' }>();

    for await (const chunk of this.stream(request)) {
      switch (chunk.type) {
        case 'request_degraded':
          // complete() 没有 SSE 消费者；降级已在请求内部完成，不影响结果聚合。
          break;
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
    const entry = this.providerRegistry.get(providerId);
    if (!entry) return { ok: false, error: `provider/not_configured: no config registered for "${providerId}"` };

    const start = Date.now();
    try {
      for await (const chunk of entry.adapter.stream(
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
    return this.providerRegistry.get(providerId)?.config.protocol;
  }

  /** 按 Provider + Model 精确返回能力；同名模型不会跨 Provider 串数据。 */
  capabilitiesFor(providerId: string, model: string): ModelCapabilitySnapshot {
    const config = this.providerRegistry.get(providerId)?.config;
    const spec = config?.modelsDevId && this.catalog
      ? this.catalog.get(config.modelsDevId, model)
      : undefined;
    if (spec) return capabilitiesFromCatalog(spec);
    if (this.supportsManualImageInput?.(providerId, model)) {
      return capabilitiesFromManualVision();
    }
    return unknownModelCapabilities();
  }

  /** 历史消息只读降级；调用方负责把 actions 转成结构化 SSE。 */
  prepareHistoricalMessages(
    providerId: string,
    model: string,
    messages: readonly Message[],
  ): CompatibleMessageView {
    return prepareHistoricalMessageView(messages, this.capabilitiesFor(providerId, model));
  }

  /** 本轮新附件不允许静默丢弃；能力 unknown 也会 fail-closed。 */
  assertCurrentContentCompatible(
    providerId: string,
    model: string,
    parts: readonly LlmContentPart[],
  ): void {
    const issues = validateCurrentContent(parts, this.capabilitiesFor(providerId, model));
    if (issues.length > 0) {
      throw new LlmModelCapabilityError(providerId, model, issues);
    }
  }

  // ── 热重载 ───────────────────────────────────────────────

  /**
   * 用完整 Provider 快照替换运行时配置。
   *
   * 新 Adapter 全部构造成功后才交换 Map；构造失败时旧运行时保持不变。
   * 已经开始的请求持有旧 Adapter 的局部引用，可以自然完成；后续请求只会
   * 从新 Map 取值。
   */
  reload(configs: ProviderConfig[]): void {
    const affectedProviderIds = this.providerRegistry.replace(configs);
    for (const providerId of affectedProviderIds) {
      this.streamRuntime.reset(providerId);
    }
  }

  /** 运行时新增或替换 provider config(如用户更新了 API key)。 */
  upsertConfig(config: ProviderConfig): void {
    this.providerRegistry.upsert(config);
    this.streamRuntime.reset(config.id);
  }

  removeConfig(providerId: string): void {
    this.providerRegistry.remove(providerId);
    this.streamRuntime.reset(providerId);
  }

  /** 返回首个已注册 config id,无则 undefined。用作最后兜底。 */
  firstProviderId(): string | undefined {
    return this.providerRegistry.firstProviderId();
  }

  /** 返回给定 provider id 的 defaultModel,无则 undefined。 */
  defaultModelFor(providerId: string): string | undefined {
    return this.providerRegistry.defaultModelFor(providerId);
  }

  /**
   * 检查哪些 content part 与给定 provider 不兼容。
   * 内部查 provider 的 protocol - 调用方无需知道 provider 用哪种线路格式。
   * 全部兼容时返回空数组。
   */
  warnUnsupportedParts(providerId: string, parts: LlmContentPart[]): UnsupportedPart[] {
    const protocol = this.providerRegistry.get(providerId)?.config.protocol;
    if (!protocol) throw notConfigured(providerId);
    return validateContentParts(parts, protocol);
  }
}

function usageErrorCode(error: unknown): string {
  if (error instanceof Error) {
    const candidate = (error as Error & { code?: unknown }).code;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    if (error.name === 'AbortError') return 'llm/aborted';
  }
  return 'llm/provider_failed';
}
