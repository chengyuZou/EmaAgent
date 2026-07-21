// Vision 运行时执行图片提取，并原子维护 Provider Adapter、并发限制、取消与 Usage。
import { randomUUID } from 'node:crypto';
import type { VisionProtocol } from '@ema-agent/provider';
import type { UsageRecord, UsageRecorder } from '@ema-agent/usage';
import { AnthropicVisionAdapter } from './adapters/anthropic.js';
import type { VisionAdapter } from './adapters/base.js';
import { GeminiVisionAdapter } from './adapters/gemini.js';
import { OpenAiVisionAdapter } from './adapters/openAi.js';
import {
  VisionLimiter,
  type VisionConcurrencyLimiter,
} from './concurrencyLimiter.js';
import { VisionError, classifyVisionError } from './errors.js';
import {
  DEFAULT_VISION_LIMITS,
  normalizeVisionRequest,
  resolveVisionLimits,
  validateVisionLimits,
  validateVisionRequest,
  type NormalizedVisionRequest,
} from './requestValidation.js';
import { createVisionRequestScope } from './requestScope.js';
import type {
  VisionExtractionResult,
  VisionLimits,
  VisionProbeResult,
  VisionProviderConfig,
  VisionRequest,
} from './types.js';

interface VisionRuntimeEntry {
  readonly config: Readonly<VisionProviderConfig>;
  readonly adapter: VisionAdapter;
}

export interface VisionRuntimeOptions {
  configs: readonly VisionProviderConfig[];
  limits?: Partial<VisionLimits>;
  adapterOverrides?: ReadonlyMap<string, VisionAdapter>;
  limiter?: VisionConcurrencyLimiter;
  usageRecorder?: UsageRecorder;
  onUsageRecordError?: (error: unknown, record: UsageRecord) => void;
}

export class VisionRuntime {
  private entries: ReadonlyMap<string, VisionRuntimeEntry>;
  private readonly adapterOverrides?: ReadonlyMap<string, VisionAdapter>;
  private readonly limiter: VisionConcurrencyLimiter;
  private readonly limits: VisionLimits;
  private readonly usageRecorder?: UsageRecorder;
  private readonly onUsageRecordError?: (error: unknown, record: UsageRecord) => void;

  constructor(options: VisionRuntimeOptions) {
    this.adapterOverrides = options.adapterOverrides;
    this.limiter = options.limiter ?? new VisionLimiter();
    this.limits = { ...DEFAULT_VISION_LIMITS, ...options.limits };
    this.usageRecorder = options.usageRecorder;
    this.onUsageRecordError = options.onUsageRecordError;
    validateVisionLimits(this.limits);
    this.entries = this.buildEntries(options.configs);
  }

  async extract(request: VisionRequest): Promise<VisionExtractionResult> {
    const normalized = normalizeVisionRequest(request);
    const limits = resolveVisionLimits(this.limits, normalized.limits);
    validateVisionLimits(limits);
    validateVisionRequest(normalized, limits);

    // 领取队列槽位前固定本次 Entry；热刷新只影响后续请求，不替换已接受请求的 Adapter。
    const entry = this.entries.get(normalized.providerId);
    if (!entry) throw notConfigured(normalized.providerId);

    const scope = createVisionRequestScope(normalized.signal, limits.timeoutMs);
    let providerStartedAt: number | undefined;
    let release: (() => void) | undefined;
    try {
      release = await this.limiter.acquire(
        normalized.providerId,
        limits.maxConcurrentGlobal,
        limits.maxConcurrentPerProvider,
        limits.maxQueuedRequests,
        scope.signal,
      );
      providerStartedAt = Date.now();
      const result = await entry.adapter.extract({ ...normalized, signal: scope.signal });
      this.recordUsage(normalized, result, providerStartedAt, null);
      return result;
    } catch (error) {
      const classified = classifyVisionError(error, requestErrorContext(normalized), scope.timedOut());
      // 排队失败未触达 Provider，不能伪造模型消费记录。
      if (providerStartedAt !== undefined) {
        this.recordUsage(normalized, undefined, providerStartedAt, classified.code);
      }
      throw classified;
    } finally {
      scope.dispose();
      release?.();
    }
  }

  async probe(providerId: string, model: string, signal?: AbortSignal): Promise<VisionProbeResult> {
    const entry = this.entries.get(providerId);
    if (!entry) return { ok: false, error: 'vision/not_configured' };
    if (!model.trim()) return { ok: false, error: 'vision/model_not_configured' };
    if (!entry.adapter.probe) return { ok: false, error: 'vision/probe_not_supported' };

    const scope = createVisionRequestScope(signal, Math.min(this.limits.timeoutMs, 10_000));
    const startedAt = Date.now();
    try {
      const result = await entry.adapter.probe(model, scope.signal);
      if (result.ok) return result;
      return {
        ok: false,
        latencyMs: result.latencyMs ?? Date.now() - startedAt,
        error: safeProbeCode(result.error),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: classifyVisionError(
          error,
          { providerId, model },
          scope.timedOut(),
        ).code,
      };
    } finally {
      scope.dispose();
    }
  }

  getProtocol(providerId: string): VisionProtocol | undefined {
    return this.entries.get(providerId)?.config.protocol;
  }

  reload(configs: readonly VisionProviderConfig[]): void {
    this.entries = this.buildEntries(configs, this.entries);
  }

  upsertConfig(config: VisionProviderConfig): void {
    const previous = this.entries.get(config.id);
    if (previous && configsEqual(previous.config, config)) return;
    const next = new Map(this.entries);
    next.set(config.id, this.createEntry(config));
    this.entries = next;
  }

  removeConfig(providerId: string): void {
    if (!this.entries.has(providerId)) return;
    const next = new Map(this.entries);
    next.delete(providerId);
    this.entries = next;
  }

  private buildEntries(
    configs: readonly VisionProviderConfig[],
    previous?: ReadonlyMap<string, VisionRuntimeEntry>,
  ): ReadonlyMap<string, VisionRuntimeEntry> {
    const entries = new Map<string, VisionRuntimeEntry>();
    for (const config of configs) {
      if (entries.has(config.id)) {
        throw new VisionError(
          'vision/invalid_request',
          `Duplicate Vision provider config "${config.id}"`,
          { providerId: config.id },
        );
      }
      const oldEntry = previous?.get(config.id);
      entries.set(
        config.id,
        oldEntry && configsEqual(oldEntry.config, config) ? oldEntry : this.createEntry(config),
      );
    }
    return entries;
  }

  private createEntry(config: VisionProviderConfig): VisionRuntimeEntry {
    const snapshot = Object.freeze({ ...config });
    const adapter = this.adapterOverrides?.get(config.id) ?? createAdapter(snapshot);
    return Object.freeze({ config: snapshot, adapter });
  }

  private recordUsage(
    request: NormalizedVisionRequest,
    result: VisionExtractionResult | undefined,
    startedAt: number,
    errorCode: string | null,
  ): void {
    const record: UsageRecord = {
      id: request.usageContext?.callId ?? randomUUID(),
      sessionId: request.usageContext?.sessionId ?? request.context?.sessionId ?? null,
      turnId: request.usageContext?.turnId ?? request.context?.turnId ?? null,
      providerId: request.providerId,
      modelId: request.model,
      capability: 'vision',
      status: errorCode === null ? 'completed' : 'failed',
      inputTokens: result?.usage?.inputTokens ?? null,
      outputTokens: result?.usage?.outputTokens ?? null,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      quantity: request.inputs.length,
      unit: 'image',
      costUsd: null,
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode,
      createdAt: startedAt,
    };
    try {
      this.usageRecorder?.record(record);
    } catch (error) {
      try {
        this.onUsageRecordError?.(error, record);
      } catch {
        // 用量写入属于观测链路，不能改变 Vision 主调用结果。
      }
    }
  }
}

function createAdapter(config: VisionProviderConfig): VisionAdapter {
  switch (config.protocol) {
    case 'openai-vision': return new OpenAiVisionAdapter(config);
    case 'anthropic-vision': return new AnthropicVisionAdapter(config);
    case 'gemini-vision': return new GeminiVisionAdapter(config);
  }
}

function notConfigured(providerId: string): VisionError {
  return new VisionError(
    'vision/not_configured',
    `Vision provider "${providerId}" is not configured`,
    { providerId, retryable: false },
  );
}

function requestErrorContext(request: NormalizedVisionRequest) {
  return {
    providerId: request.providerId,
    model: request.model,
    task: request.task,
    invocationContext: request.context,
  };
}

function configsEqual(left: Readonly<VisionProviderConfig>, right: VisionProviderConfig): boolean {
  return left.id === right.id
    && left.protocol === right.protocol
    && left.apiKey === right.apiKey
    && left.baseUrl === right.baseUrl;
}

function safeProbeCode(error: string | undefined): string {
  return error?.startsWith('vision/') ? error : 'vision/probe_failed';
}
