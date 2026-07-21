// STT 运行时执行整段音频转录，并控制请求限制、取消和 Usage 记录。
import { randomUUID } from 'node:crypto';
import type { SttAdapter, SttAdapterCall, SttProviderConfig, SttRequest, SttResponse, SttHealthResult, SttProbeResult } from './types.js';
import { OpenAiSttAdapter } from './adapters/openAi.js';
import { isSttError, SttError } from './errors.js';
import { createSttRequestScope } from './requestScope.js';
import type { SttLimits } from './types.js';
import type { UsageRecord, UsageRecorder } from '@ema-agent/usage';

interface SttRuntimeEntry {
  readonly config: Readonly<SttProviderConfig>;
  readonly adapter: SttAdapter;
}

export interface SttRuntimeOptions {
  configs: readonly SttProviderConfig[];
  adapterOverrides?: ReadonlyMap<string, SttAdapter>;
  limits?: Partial<SttLimits>;
  usageRecorder?: UsageRecorder;
  onUsageRecordError?: (error: unknown, record: UsageRecord) => void;
}

const DEFAULT_LIMITS: Readonly<SttLimits> = {
  maxAudioBytes: 25 * 1024 * 1024,
  timeoutMs: 120_000,
};

// ── SttRuntime ──────────────────────────────────────────────────────────────
//
// 与其他模型能力 Runtime 一致:
//   - 持有 provider configs + adapters,按 provider_configs.id 索引。
//   - 路由(用哪个 providerId + model)总由调用方决定
//     (route handler 读 model_bindings.get('stt'))。
//   - 这里不存 binding - binding 是业务层的事。

function createAdapter(cfg: Readonly<SttProviderConfig>): SttAdapter {
  switch (cfg.protocol) {
    case 'openai-stt': return new OpenAiSttAdapter(cfg);
  }
}

export class SttRuntime {
  private entries: ReadonlyMap<string, SttRuntimeEntry>;
  private readonly adapterOverrides?: ReadonlyMap<string, SttAdapter>;
  private readonly limits: Readonly<SttLimits>;
  private readonly usageRecorder?: UsageRecorder;
  private readonly onUsageRecordError?: (error: unknown, record: UsageRecord) => void;

  constructor(options: SttRuntimeOptions) {
    this.adapterOverrides = options.adapterOverrides;
    this.limits = validateLimits({ ...DEFAULT_LIMITS, ...options.limits });
    this.usageRecorder = options.usageRecorder;
    this.onUsageRecordError = options.onUsageRecordError;
    this.entries = this.buildEntries(options.configs);
  }

  /** 至少注册了一个 STT provider 时为 true。 */
  isAvailable(): boolean {
    return this.entries.size > 0;
  }

  maximumAudioBytes(): number {
    return this.limits.maxAudioBytes;
  }

  /** 健康检查 - 验证至少配置了一个 STT provider。V1 只查配置,无实时 API 调用。 */
  healthCheck(): SttHealthResult {
    const providers = [...this.entries.entries()].map(([id, entry]) => ({
      providerId: id,
      protocol:   entry.config.protocol,
      ok:         true,
    }));
    return {
      ok: providers.length > 0 && providers.every((p) => p.ok),
      providers,
    };
  }

  /** 热重载:原子替换所有 provider 配置。 */
  reload(configs: readonly SttProviderConfig[]): void {
    this.entries = this.buildEntries(configs, this.entries);
  }

  /**
   * 实时探测 - 发真实 API 调用验证凭证。
   * 设置页通过该入口执行可取消、限时且错误信息稳定的连通性探测。
   *
   * adapter 有 probe() 时委托;adapter 无 probe 时回退
   * ok=false + "probe not supported"(V1 不会发生,openai-stt 实现了)。
   */
  async probe(providerId: string, signal?: AbortSignal): Promise<SttProbeResult> {
    const adapter = this.entries.get(providerId)?.adapter;
    if (!adapter) {
      return { providerId, ok: false, error: 'stt/not_configured' };
    }
    if (!adapter.probe) {
      return { providerId, ok: false, error: 'stt/probe_not_supported' };
    }
    const scope = createSttRequestScope(signal, 10_000);
    try {
      const result = await adapter.probe(scope.signal);
      return {
        providerId,
        ...result,
        error: result.ok ? undefined : safeProbeCode(result.error),
      };
    } catch {
      const reason = scope.signal.reason;
      return {
        providerId,
        ok: false,
        error: isSttError(reason) ? `stt/${reason.code}` : 'stt/probe_failed',
      };
    } finally {
      scope.dispose();
    }
  }

  /** 转录音频。providerId + model 是嵌在请求里的路由字段。 */
  async transcribe(req: SttRequest): Promise<SttResponse> {
    validateRequest(req, this.limits);
    const adapter = this.entries.get(req.providerId)?.adapter;
    if (!adapter) {
      throw new SttError(
        'not_configured',
        `stt/not_configured: provider "${req.providerId}" not registered`,
        { providerId: req.providerId, model: req.model },
      );
    }
    const scope = createSttRequestScope(req.abortSignal, this.limits.timeoutMs);
    const startedAt = Date.now();
    const call: SttAdapterCall = {
      audio:       req.audio,
      mime:        req.mime,
      model:       req.model,
      language:    req.language,
      abortSignal: scope.signal,
    };
    try {
      const response = await adapter.transcribe(call);
      if (scope.signal.aborted) throw scope.signal.reason;
      this.recordUsage(req, startedAt, null);
      return response;
    } catch (error) {
      let failure: SttError;
      if (isSttError(error)) {
        failure = withRequestContext(error, req);
      } else if (scope.signal.aborted && isSttError(scope.signal.reason)) {
        failure = scope.signal.reason;
      } else {
        failure = new SttError('provider_failed', 'STT provider request failed', {
          cause: error,
          retryable: true,
          providerId: req.providerId,
          model: req.model,
        });
      }
      this.recordUsage(req, startedAt, `stt/${failure.code}`);
      throw failure;
    } finally {
      scope.dispose();
    }
  }

  /** 热重载:新增或替换一个 provider 配置。 */
  upsertConfig(config: SttProviderConfig): void {
    const previous = this.entries.get(config.id);
    if (previous && configsEqual(previous.config, config)) return;
    const entries = new Map(this.entries);
    entries.set(config.id, this.createEntry(config));
    this.entries = entries;
  }

  removeConfig(id: string): void {
    if (!this.entries.has(id)) return;
    const entries = new Map(this.entries);
    entries.delete(id);
    this.entries = entries;
  }

  private createEntry(config: SttProviderConfig): SttRuntimeEntry {
    const snapshot = Object.freeze({ ...config });
    const adapter = this.adapterOverrides?.get(config.id) ?? createAdapter(snapshot);
    return Object.freeze({ config: snapshot, adapter });
  }

  private buildEntries(
    configs: readonly SttProviderConfig[],
    previous?: ReadonlyMap<string, SttRuntimeEntry>,
  ): ReadonlyMap<string, SttRuntimeEntry> {
    const entries = new Map<string, SttRuntimeEntry>();
    for (const config of configs) {
      if (entries.has(config.id)) {
        throw new TypeError(`Duplicate STT provider config "${config.id}"`);
      }
      const oldEntry = previous?.get(config.id);
      entries.set(
        config.id,
        oldEntry && configsEqual(oldEntry.config, config) ? oldEntry : this.createEntry(config),
      );
    }
    return entries;
  }

  private recordUsage(req: SttRequest, startedAt: number, errorCode: string | null): void {
    const record: UsageRecord = {
      id: req.usageContext?.callId ?? randomUUID(),
      sessionId: req.usageContext?.sessionId ?? null,
      turnId: req.usageContext?.turnId ?? null,
      providerId: req.providerId,
      modelId: req.model,
      capability: 'stt',
      status: errorCode === null ? 'completed' : 'failed',
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      quantity: req.audio.byteLength,
      unit: 'byte',
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
        // 记录失败不能覆盖真实的 STT 调用结果。
      }
    }
  }
}

function validateLimits(limits: SttLimits): Readonly<SttLimits> {
  if (!Number.isSafeInteger(limits.maxAudioBytes) || limits.maxAudioBytes <= 0) {
    throw new TypeError('STT maxAudioBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0) {
    throw new TypeError('STT timeoutMs must be a positive safe integer');
  }
  return Object.freeze(limits);
}

function validateRequest(req: SttRequest, limits: Readonly<SttLimits>): void {
  if (!req.providerId.trim() || !req.model.trim() || !req.mime.trim()) {
    throw new SttError('invalid_request', 'providerId, model and mime are required');
  }
  if (req.audio.byteLength === 0) {
    throw new SttError('invalid_request', 'audio must not be empty');
  }
  if (req.audio.byteLength > limits.maxAudioBytes) {
    throw new SttError(
      'payload_too_large',
      `audio payload is ${req.audio.byteLength} bytes; limit is ${limits.maxAudioBytes} bytes`,
    );
  }
}

function configsEqual(left: Readonly<SttProviderConfig>, right: SttProviderConfig): boolean {
  return left.id === right.id
    && left.protocol === right.protocol
    && left.apiKey === right.apiKey
    && left.baseUrl === right.baseUrl;
}

function withRequestContext(error: SttError, request: SttRequest): SttError {
  return new SttError(error.code, error.message, {
    cause: error.cause,
    retryable: error.retryable,
    status: error.status,
    providerId: error.providerId ?? request.providerId,
    model: error.model ?? request.model,
  });
}

function safeProbeCode(error: string | undefined): string {
  return error?.startsWith('stt/') ? error : 'stt/probe_failed';
}
