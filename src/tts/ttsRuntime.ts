// TTS 运行时按 Provider 执行单句合成，并控制超时、字节上限和 Usage 记录。

import { randomUUID } from 'node:crypto';
import type {
  TtsRequest,
  TtsStreamEvent,
  TtsAdapter,
  TtsProviderConfig,
  TtsHealthResult,
  TtsProbeResult,
  TtsLimits,
  TtsAdapterCapabilities,
} from './types.js';

import { OpenAiTtsAdapter } from './adapters/openAi.js';
import { GptSoVitsTtsAdapter } from './adapters/gptSoVits.js';
import { DashscopeTtsAdapter } from './adapters/dashscope.js';

import { filterSentenceForTts } from './streaming/textFilter.js';
import { createTtsRequestScope, nextWithAbort } from './requestScope.js';
import type { UsageRecord, UsageRecorder } from '@ema-agent/usage';

interface TtsRuntimeEntry {
  readonly config: Readonly<TtsProviderConfig>;
  readonly adapter: TtsAdapter;
}

export interface TtsRuntimeOptions {
  configs: readonly TtsProviderConfig[];
  adapterOverrides?: ReadonlyMap<string, TtsAdapter>;
  limits?: Partial<TtsLimits>;
  usageRecorder?: UsageRecorder;
  onUsageRecordError?: (error: unknown, record: UsageRecord) => void;
}

const DEFAULT_LIMITS: Readonly<TtsLimits> = {
  timeoutMsPerSentence: 120_000,
  maxBytesPerSentence: 16 * 1024 * 1024,
};

// ── TtsRuntime ──────────────────────────────────────────────────────────────

/**
 * 文本转语音的哑分发器。模式与 LanguageModelRuntime 对齐:
 *
 *   - adapters: Map<providerId, TtsAdapter>     (id -> 实例)
 *   - configs:  Map<providerId, TtsProviderConfig> (id -> 配置)
 *
 * TtsRuntime 不感知角色卡、voice profile、
 * 文件路径、Provider 声音句柄缓存或 fallback 策略。这些职责由 TurnSpeechOutput 的装配端承担。
 *
 * synthesize(request) 接收完全解析的 TtsVoiceRef - 调用方负责
 * 从角色卡解析 voice，并在调用前确保云端协议需要的 Provider 句柄已填。
 */
export class TtsRuntime {
  private entries: ReadonlyMap<string, TtsRuntimeEntry>;
  private readonly adapterOverrides?: ReadonlyMap<string, TtsAdapter>;
  private readonly limits: Readonly<TtsLimits>;
  private readonly usageRecorder?: UsageRecorder;
  private readonly onUsageRecordError?: (error: unknown, record: UsageRecord) => void;

  /**
   * @param configs           Provider 配置(来自 profile.db)。
   * @param adapterOverrides  预构建的 adapter,按 provider id 索引(测试在此注入 mock)。
   */
  constructor(options: TtsRuntimeOptions) {
    this.adapterOverrides = options.adapterOverrides;
    this.limits = validateLimits({ ...DEFAULT_LIMITS, ...options.limits });
    this.usageRecorder = options.usageRecorder;
    this.onUsageRecordError = options.onUsageRecordError;
    this.entries = this.buildEntries(options.configs);
  }

  // ── 热重载 ──────────────────────────────────────────────────────────────

  reload(configs: readonly TtsProviderConfig[]): void {
    this.entries = this.buildEntries(configs, this.entries);
  }

  /** 与 LanguageModelRuntime.upsertConfig() 对称。 */
  upsertConfig(config: TtsProviderConfig): void {
    const previous = this.entries.get(config.id);
    if (previous && configsEqual(previous.config, config)) return;
    const entries = new Map(this.entries);
    entries.set(config.id, this.createEntry(config));
    this.entries = entries;
  }

  /** 与 LanguageModelRuntime.removeConfig() 对称。 */
  removeConfig(providerId: string): void {
    if (!this.entries.has(providerId)) return;
    const entries = new Map(this.entries);
    entries.delete(providerId);
    this.entries = entries;
  }

  /** 按 provider id 取 adapter(用于 voice 解析 / 缓存管理)。 */
  getAdapter(providerId: string): TtsAdapter | undefined {
    return this.entries.get(providerId)?.adapter;
  }

  /** 返回当前适配器实现的真实交付能力,供诊断与后续设置页展示。 */
  capabilitiesFor(providerId: string, model: string): TtsAdapterCapabilities | undefined {
    return this.entries.get(providerId)?.adapter.capabilitiesFor({ model });
  }

  /**
   * 健康检查 - 验证至少配置了一个 TTS provider。
   *
   * V1 只做配置检查(无实时 API 调用)。provider 的 adapter 成功注册
   * 即视为健康(即其 config 通过了 wiring 层的 `buildTtsProviderConfig`
   * 校验)。API key 的实际有效性在首次合成调用时验证。
   */
  healthCheck(): TtsHealthResult {
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

  async probe(providerId: string, signal?: AbortSignal): Promise<TtsProbeResult> {
    const adapter = this.entries.get(providerId)?.adapter;
    if (!adapter) return { ok: false, error: 'tts/not_configured' };
    if (!adapter.probe) return { ok: false, error: 'tts/probe_not_supported' };
    const scope = createTtsRequestScope(signal, 10_000);
    try {
      const result = await adapter.probe(scope.signal);
      return result.ok
        ? result
        : { ...result, error: safeProbeCode(result.error) };
    } catch {
      const reason = scope.reason();
      return {
        ok: false,
        error: reason === 'timeout' ? 'tts/transient_timeout'
          : reason === 'aborted' ? 'tts/aborted'
          : 'tts/probe_failed',
      };
    } finally {
      scope.dispose();
    }
  }

  private createAdapter(cfg: Readonly<TtsProviderConfig>): TtsAdapter {
    switch (cfg.protocol) {
      case 'openai-tts':     return new OpenAiTtsAdapter(cfg);
      case 'gpt-sovits-tts': return new GptSoVitsTtsAdapter(cfg);
      case 'dashscope-tts':  return new DashscopeTtsAdapter(cfg);
    }
  }

  private createEntry(config: TtsProviderConfig): TtsRuntimeEntry {
    const snapshot = Object.freeze({ ...config });
    const adapter = this.adapterOverrides?.get(config.id) ?? this.createAdapter(snapshot);
    return Object.freeze({ config: snapshot, adapter });
  }

  private buildEntries(
    configs: readonly TtsProviderConfig[],
    previous?: ReadonlyMap<string, TtsRuntimeEntry>,
  ): ReadonlyMap<string, TtsRuntimeEntry> {
    const entries = new Map<string, TtsRuntimeEntry>();
    for (const config of configs) {
      if (entries.has(config.id)) {
        throw new TypeError(`Duplicate TTS provider config "${config.id}"`);
      }
      const oldEntry = previous?.get(config.id);
      entries.set(
        config.id,
        oldEntry && configsEqual(oldEntry.config, config) ? oldEntry : this.createEntry(config),
      );
    }
    return entries;
  }

  // ── 公共 API ─────────────────────────────────────────────────────────────

  /**
   * 将单个文本段合成为音频块。
   *
   * 调用方(TtsCoordinator)负责:
   *   1. 句子切分 - 每次 synthesize() 调用接收一句话。
   *   2. Voice 解析 - request.voice 是完全解析的 TtsVoiceRef,
   *      providerVoice 已填（由 apps/localHost 在调用前填好）。
   *   3. 错误处理 - TtsRuntime 产出 TtsStreamEvent.error;调用方
   *      决定重试、fallback 还是上报用户。
   *
   * TtsRuntime 只负责:
   *   1. 行内清洗 - 调 filterSentenceForTts 剥行内 markdown / 网址 / 路径。
   *      (块级代码块/数学块由 coordinator 的 TextFilterStream 在切句前剥;
   *      ACT 标签由 emotion 包在 engine 内剥,都不归本层。)
   *   2. 按 request.providerId 查 adapter。
   *   3. 委托 adapter.stream()。
   */
  async *synthesize(req: TtsRequest): AsyncIterable<TtsStreamEvent> {
    const cleaned = filterSentenceForTts(req.text);
    if (cleaned.length === 0) {
      yield { type: 'done', totalBytes: 0, firstByteMs: 0 };
      return;
    }

    const adapter = this.entries.get(req.providerId)?.adapter;
    if (!adapter) {
      yield { type: 'error', code: 'permanent_bad_request',
              message: `tts/provider not registered: "${req.providerId}"` };
      return;
    }

    // 构造归一化副本 - 永不修改调用方的 request 对象。
    const scope = createTtsRequestScope(req.abortSignal, this.limits.timeoutMsPerSentence);
    const normalized: TtsRequest = {
      ...req,
      text: cleaned,
      format: req.format ?? 'mp3',
      abortSignal: scope.signal,
    };
    const iterator = adapter.stream(normalized)[Symbol.asyncIterator]();
    const startedAt = Date.now();
    let totalBytes = 0;
    let terminal = false;
    let endedWithoutTerminal = false;
    let usageErrorCode: string | null = 'tts/stream_incomplete';

    try {
      while (!terminal) {
        const item = await nextWithAbort(iterator, scope.signal);
        if (item.done) {
          endedWithoutTerminal = true;
          break;
        }
        const event = item.value;
        if (event.type === 'audio_chunk') {
          totalBytes += event.bytes.byteLength;
          if (totalBytes > this.limits.maxBytesPerSentence) {
            scope.abort('resource_exhausted');
            yield {
              type: 'error',
              code: 'resource_exhausted',
              message: `TTS sentence exceeded ${this.limits.maxBytesPerSentence} bytes`,
            };
            usageErrorCode = 'tts/resource_exhausted';
            terminal = true;
            continue;
          }
        }
        yield event;
        terminal = event.type === 'done' || event.type === 'error';
        if (event.type === 'done') usageErrorCode = null;
        if (event.type === 'error') usageErrorCode = `tts/${event.code}`;
      }
      if (endedWithoutTerminal && !terminal) {
        yield {
          type: 'error',
          code: 'invalid_stream',
          message: 'TTS adapter ended without a terminal done or error event',
        };
        usageErrorCode = 'tts/invalid_stream';
      }
    } catch (error) {
      const reason = scope.reason();
      const code = reason === 'timeout' ? 'transient_timeout'
        : reason === 'resource_exhausted' ? 'resource_exhausted'
        : reason === 'aborted' ? 'aborted'
        : 'unknown';
      usageErrorCode = `tts/${code}`;
      yield {
        type: 'error',
        code,
        message: reason === 'timeout'
          ? `TTS sentence exceeded its ${this.limits.timeoutMsPerSentence}ms deadline`
          : reason === 'aborted'
            ? 'TTS sentence was aborted'
            : error instanceof Error ? error.message : 'TTS adapter failed',
      };
    } finally {
      try {
        const closing = iterator.return?.();
        if (closing) {
          if (scope.signal.aborted) void closing.catch(() => undefined);
          else await closing;
        }
      } finally {
        scope.dispose();
        this.recordUsage(normalized, cleaned.length, startedAt, usageErrorCode);
      }
    }
  }

  private recordUsage(
    req: TtsRequest,
    characterCount: number,
    startedAt: number,
    errorCode: string | null,
  ): void {
    const record: UsageRecord = {
      id: req.usageContext?.callId ?? randomUUID(),
      sessionId: req.usageContext?.sessionId ?? null,
      turnId: req.usageContext?.turnId ?? null,
      providerId: req.providerId,
      modelId: req.model,
      capability: 'tts',
      status: errorCode === null ? 'completed' : 'failed',
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      quantity: characterCount,
      unit: 'character',
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
        // 用量记录失败不能改变已经产生的音频流。
      }
    }
  }
}

function validateLimits(limits: TtsLimits): Readonly<TtsLimits> {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`TTS ${key} must be a positive safe integer`);
    }
  }
  return Object.freeze(limits);
}

function configsEqual(left: Readonly<TtsProviderConfig>, right: TtsProviderConfig): boolean {
  return left.id === right.id
    && left.protocol === right.protocol
    && left.apiKey === right.apiKey
    && left.baseUrl === right.baseUrl;
}

function safeProbeCode(error: string | undefined): string {
  return error?.startsWith('tts/') ? error : 'tts/probe_failed';
}
