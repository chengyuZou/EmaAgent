// STT Facade 负责请求限制、取消和 Provider 路由，并记录每次真实转录调用的用量。
import { randomUUID } from 'node:crypto';
import type { SttAdapter, SttAdapterCall, SttProviderConfig, SttRequest, SttResponse, SttHealthResult, SttProbeResult } from './types.js';
import { OpenAiSttAdapter } from './adapters/openai-stt.js';
import { isSttError, SttError } from './errors.js';
import { createSttRequestScope } from './request-scope.js';
import type { SttLimits } from './types.js';
import type { UsageRecord, UsageRecorder } from '@ema-agent/usage';

export interface SttClientOptions {
  usageRecorder?: UsageRecorder;
  onUsageRecordError?: (error: unknown, record: UsageRecord) => void;
}

const DEFAULT_LIMITS: Readonly<SttLimits> = {
  maxAudioBytes: 25 * 1024 * 1024,
  timeoutMs: 120_000,
};

// ── SttClient Facade ────────────────────────────────────────────────────────
//
// 与 TtsClient / LanguageModelRuntime 对称:
//   - 持有 provider configs + adapters,按 provider_configs.id 索引。
//   - 路由(用哪个 providerId + model)总由调用方决定
//     (route handler 读 model_bindings.get('stt'))。
//   - 这里不存 binding - binding 是业务层的事。

function createAdapter(cfg: SttProviderConfig): SttAdapter {
  switch (cfg.protocol) {
    case 'openai-stt': return new OpenAiSttAdapter(cfg);
  }
}

export class SttClient {
  private adapters = new Map<string, SttAdapter>();
  private configs  = new Map<string, SttProviderConfig>();
  private readonly limits: Readonly<SttLimits>;
  private readonly usageRecorder?: UsageRecorder;
  private readonly onUsageRecordError?: (error: unknown, record: UsageRecord) => void;

  constructor(
    configs: SttProviderConfig[],
    adapterOverrides?: ReadonlyMap<string, SttAdapter>,
    limits: Partial<SttLimits> = {},
    options: SttClientOptions = {},
  ) {
    this.limits = validateLimits({ ...DEFAULT_LIMITS, ...limits });
    this.usageRecorder = options.usageRecorder;
    this.onUsageRecordError = options.onUsageRecordError;
    for (const config of configs) {
      this.configs.set(config.id, config);
      const override = adapterOverrides?.get(config.id);
      this.adapters.set(config.id, override ?? createAdapter(config));
    }
    if (adapterOverrides) {
      for (const [id, adapter] of adapterOverrides) {
        if (!this.adapters.has(id)) this.adapters.set(id, adapter);
      }
    }
  }

  /** 至少注册了一个 STT provider 时为 true。 */
  isAvailable(): boolean {
    return this.adapters.size > 0;
  }

  /** 健康检查 - 验证至少配置了一个 STT provider。V1 只查配置,无实时 API 调用。 */
  healthCheck(): SttHealthResult {
    const providers = [...this.configs.entries()].map(([id, cfg]) => ({
      providerId: id,
      protocol:   cfg.protocol,
      ok:         this.adapters.has(id),
    }));
    return {
      ok: providers.length > 0 && providers.every((p) => p.ok),
      providers,
    };
  }

  /** 热重载:原子替换所有 provider 配置。 */
  reload(configs: SttProviderConfig[]): void {
    const nextAdapters = new Map<string, SttAdapter>();
    const nextConfigs = new Map<string, SttProviderConfig>();
    for (const config of configs) {
      nextConfigs.set(config.id, config);
      nextAdapters.set(config.id, createAdapter(config));
    }
    this.configs = nextConfigs;
    this.adapters = nextAdapters;
  }

  /**
   * 实时探测 - 发真实 API 调用验证凭证。
   * 与 LanguageModelRuntime.probe() / TtsClient 对应物对称。
   *
   * adapter 有 probe() 时委托;adapter 无 probe 时回退
   * ok=false + "probe not supported"(V1 不会发生,openai-stt 实现了)。
   */
  async probe(providerId: string): Promise<SttProbeResult> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      return { providerId, ok: false, error: `provider "${providerId}" not registered` };
    }
    if (!adapter.probe) {
      return { providerId, ok: false, error: 'probe not supported by this adapter' };
    }
    const result = await adapter.probe();
    return { providerId, ...result };
  }

  /** 转录音频。providerId + model 是嵌在请求里的路由字段。 */
  async transcribe(req: SttRequest): Promise<SttResponse> {
    validateRequest(req, this.limits);
    const adapter = this.adapters.get(req.providerId);
    if (!adapter) {
      throw new SttError(
        'not_configured',
        `stt/not_configured: provider "${req.providerId}" not registered`,
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
        failure = error;
      } else if (scope.signal.aborted && isSttError(scope.signal.reason)) {
        failure = scope.signal.reason;
      } else {
        failure = new SttError('provider_failed', 'STT provider request failed', {
          cause: error,
          retryable: true,
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
    this.configs.set(config.id, config);
    this.adapters.set(config.id, createAdapter(config));
  }

  removeConfig(id: string): void {
    this.configs.delete(id);
    this.adapters.delete(id);
  }

  firstProviderId(): string | undefined {
    return this.configs.keys().next().value;
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
