// TTS 哑分发器：按 provider 查 adapter，单句合成带超时和字节上限，不感知角色卡和 voice。

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

import { OpenAiTtsAdapter }   from './adapters/openai-tts.js';
import { GptSoVitsTtsAdapter } from './adapters/gpt-sovits-tts.js';
import { DashscopeTtsAdapter } from './adapters/dashscope-tts.js';

import { filterSentenceForTts } from './streaming/text-filter.js';

const DEFAULT_LIMITS: Readonly<TtsLimits> = {
  timeoutMsPerSentence: 120_000,
  maxBytesPerSentence: 16 * 1024 * 1024,
};

// ── TtsClient ───────────────────────────────────────────────────────────────

/**
 * Text-to-Speech 路由器。模式与 LlmRouter 对齐:
 *
 *   - adapters: Map<providerId, TtsAdapter>     (id -> 实例)
 *   - configs:  Map<providerId, TtsProviderConfig> (id -> 配置)
 *
 * TtsClient 是一个"哑分发器"。它不感知角色卡、voice profile、
 * 文件路径、URI 缓存或 fallback 策略。这些职责在 apps/core(orchestrator 层)。
 *
 * synthesize(request) 接收完全解析的 TtsVoiceRef - 调用方负责
 * 从角色卡解析 voice,并在调用前确保 voiceUri 已填。
 */
export class TtsClient {
  /** providerId -> adapter 实例(可热重载)*/
  private adapters = new Map<string, TtsAdapter>();
  /** providerId -> 配置 */
  private configs  = new Map<string, TtsProviderConfig>();
  private readonly limits: Readonly<TtsLimits>;

  /**
   * @param configs           Provider 配置(来自 profile.db)。
   * @param adapterOverrides  预构建的 adapter,按 provider id 索引(测试在此注入 mock)。
   */
  constructor(
    configs: TtsProviderConfig[],
    adapterOverrides?: ReadonlyMap<string, TtsAdapter>,
    limits: Partial<TtsLimits> = {},
  ) {
    this.limits = validateLimits({ ...DEFAULT_LIMITS, ...limits });
    for (const cfg of configs) {
      this.configs.set(cfg.id, cfg);
      const override = adapterOverrides?.get(cfg.id);
      this.adapters.set(cfg.id, override ?? this.createAdapter(cfg));
    }
    // 允许覆盖没有 ProviderConfig 的 provider id(纯 mock 注入)
    if (adapterOverrides) {
      for (const [id, adapter] of adapterOverrides) {
        if (!this.adapters.has(id)) this.adapters.set(id, adapter);
      }
    }
  }

  // ── 热重载 ──────────────────────────────────────────────────────────────

  reload(configs: TtsProviderConfig[]): void {
    const nextAdapters = new Map<string, TtsAdapter>();
    const nextConfigs = new Map<string, TtsProviderConfig>();
    for (const cfg of configs) {
      nextConfigs.set(cfg.id, cfg);
      nextAdapters.set(cfg.id, this.createAdapter(cfg));
    }
    this.configs = nextConfigs;
    this.adapters = nextAdapters;
  }

  /** 与 LlmRouter.upsertConfig() 对称。 */
  upsertConfig(config: TtsProviderConfig): void {
    this.configs.set(config.id, config);
    this.adapters.set(config.id, this.createAdapter(config));
  }

  /** 与 LlmRouter.removeConfig() 对称。 */
  removeConfig(providerId: string): void {
    this.configs.delete(providerId);
    this.adapters.delete(providerId);
  }

  /** 与 LlmRouter.firstProviderId() 对称。 */
  firstProviderId(): string | undefined {
    return this.configs.keys().next().value;
  }

  /** 按 provider id 取 adapter(用于 voice 解析 / 缓存管理)。 */
  getAdapter(providerId: string): TtsAdapter | undefined {
    return this.adapters.get(providerId);
  }

  /** 返回当前适配器实现的真实交付能力,供诊断与后续设置页展示。 */
  capabilitiesFor(providerId: string, model: string): TtsAdapterCapabilities | undefined {
    return this.adapters.get(providerId)?.capabilitiesFor({ model });
  }

  /**
   * 健康检查 - 验证至少配置了一个 TTS provider。
   *
   * V1 只做配置检查(无实时 API 调用)。provider 的 adapter 成功注册
   * 即视为健康(即其 config 通过了 wiring 层的 `buildTtsProviderConfig`
   * 校验)。API key 的实际有效性在首次合成调用时验证。
   */
  healthCheck(): TtsHealthResult {
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

  async probe(providerId: string): Promise<TtsProbeResult> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) return { ok: false, error: `provider "${providerId}" not registered` };
    if (!adapter.probe) return { ok: false, error: 'probe not supported by this adapter' };
    return adapter.probe();
  }

  private createAdapter(cfg: TtsProviderConfig): TtsAdapter {
    switch (cfg.protocol) {
      case 'openai-tts':     return new OpenAiTtsAdapter(cfg);
      case 'gpt-sovits-tts': return new GptSoVitsTtsAdapter(cfg);
      case 'dashscope-tts':  return new DashscopeTtsAdapter(cfg);
    }
  }

  // ── 公共 API ─────────────────────────────────────────────────────────────

  /**
   * 将单个文本段合成为音频块。
   *
   * 调用方(TtsCoordinator)负责:
   *   1. 句子切分 - 每次 synthesize() 调用接收一句话。
   *   2. Voice 解析 - request.voice 是完全解析的 TtsVoiceRef,
   *      voiceUri 已填(由 apps/core 在调用前填好)。
   *   3. 错误处理 - TtsClient 产出 TtsStreamEvent.error;调用方
   *      决定重试、fallback 还是上报用户。
   *
   * TtsClient 只负责:
   *   1. 清洗文本(剥离 markdown/code/ACT 标记)。
   *   2. 按 request.providerId 查 adapter。
   *   3. 委托 adapter.stream()。
   */
  async *synthesize(req: TtsRequest): AsyncIterable<TtsStreamEvent> {
    const cleaned = filterSentenceForTts(req.text);
    if (cleaned.length === 0) {
      yield { type: 'done', totalBytes: 0, firstByteMs: 0 };
      return;
    }

    const adapter = this.adapters.get(req.providerId);
    if (!adapter) {
      yield { type: 'error', code: 'permanent_bad_request',
              message: `tts/provider not registered: "${req.providerId}"` };
      return;
    }

    // 构造归一化副本 - 永不修改调用方的 request 对象。
    const scope = createTtsScope(req.abortSignal, this.limits.timeoutMsPerSentence);
    const normalized: TtsRequest = {
      ...req,
      text: cleaned,
      format: req.format ?? 'mp3',
      abortSignal: scope.signal,
    };
    const iterator = adapter.stream(normalized)[Symbol.asyncIterator]();
    let totalBytes = 0;
    let terminal = false;
    let endedWithoutTerminal = false;

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
            terminal = true;
            continue;
          }
        }
        yield event;
        terminal = event.type === 'done' || event.type === 'error';
      }
      if (endedWithoutTerminal && !terminal) {
        yield {
          type: 'error',
          code: 'invalid_stream',
          message: 'TTS adapter ended without a terminal done or error event',
        };
      }
    } catch (error) {
      const reason = scope.reason();
      yield {
        type: 'error',
        code: reason === 'timeout' ? 'transient_timeout'
          : reason === 'resource_exhausted' ? 'resource_exhausted'
          : reason === 'aborted' ? 'aborted'
          : 'unknown',
        message: reason === 'timeout'
          ? `TTS sentence exceeded its ${this.limits.timeoutMsPerSentence}ms deadline`
          : reason === 'aborted'
            ? 'TTS sentence was aborted'
            : error instanceof Error ? error.message : 'TTS adapter failed',
      };
    } finally {
      const closing = iterator.return?.();
      if (closing) {
        if (scope.signal.aborted) void closing.catch(() => undefined);
        else await closing;
      }
      scope.dispose();
    }
  }
}

type TtsAbortReason = 'timeout' | 'aborted' | 'resource_exhausted';

function createTtsScope(upstream: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  abort(reason: TtsAbortReason): void;
  reason(): TtsAbortReason | undefined;
  dispose(): void;
} {
  const controller = new AbortController();
  let abortReason: TtsAbortReason | undefined;
  const abort = (reason: TtsAbortReason): void => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort(reason);
  };
  const onUpstreamAbort = (): void => abort('aborted');
  if (upstream?.aborted) onUpstreamAbort();
  else upstream?.addEventListener('abort', onUpstreamAbort, { once: true });
  const timer = setTimeout(() => abort('timeout'), timeoutMs);
  return {
    signal: controller.signal,
    abort,
    reason: () => abortReason,
    dispose(): void {
      clearTimeout(timer);
      upstream?.removeEventListener('abort', onUpstreamAbort);
    },
  };
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) throw new Error(String(signal.reason ?? 'aborted'));
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const onAbort = (): void => reject(new Error(String(signal.reason ?? 'aborted')));
    signal.addEventListener('abort', onAbort, { once: true });
    iterator.next().then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function validateLimits(limits: TtsLimits): Readonly<TtsLimits> {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`TTS ${key} must be a positive safe integer`);
    }
  }
  return Object.freeze(limits);
}
