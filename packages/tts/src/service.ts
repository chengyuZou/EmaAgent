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
 * Text-to-Speech router. Pattern aligned with LlmRouter:
 *
 *   - adapters: Map<providerId, TtsAdapter>     (id → instance)
 *   - configs:  Map<providerId, TtsProviderConfig> (id → config)
 *
 * TtsClient is a DUMB DISPATCHER. It has no knowledge of characters,
 * voice profiles, file paths, URI caching, or fallback strategies.
 * Those concerns live in apps/core (the orchestrator layer).
 *
 * synthesize(request) receives a fully-resolved TtsVoiceRef — the caller
 * is responsible for resolving the voice from the character card and
 * ensuring voiceUri is populated before calling.
 */
export class TtsClient {
  /** providerId → adapter instance (hot-reloadable) */
  private adapters = new Map<string, TtsAdapter>();
  /** providerId → config */
  private configs  = new Map<string, TtsProviderConfig>();
  private readonly limits: Readonly<TtsLimits>;

  /**
   * @param configs           Provider configurations (from profile.db).
   * @param adapterOverrides  Pre-built adapters keyed by provider id (tests inject mocks here).
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
    // Allow overrides for provider ids that have no ProviderConfig (pure mock injection)
    if (adapterOverrides) {
      for (const [id, adapter] of adapterOverrides) {
        if (!this.adapters.has(id)) this.adapters.set(id, adapter);
      }
    }
  }

  // ── Hot-reload ─────────────────────────────────────────────────────────────

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

  /** Symmetric with LlmRouter.upsertConfig(). */
  upsertConfig(config: TtsProviderConfig): void {
    this.configs.set(config.id, config);
    this.adapters.set(config.id, this.createAdapter(config));
  }

  /** Symmetric with LlmRouter.removeConfig(). */
  removeConfig(providerId: string): void {
    this.configs.delete(providerId);
    this.adapters.delete(providerId);
  }

  /** Symmetric with LlmRouter.firstProviderId(). */
  firstProviderId(): string | undefined {
    return this.configs.keys().next().value;
  }

  /** Get the adapter for a provider id (for voice resolution / cache management). */
  getAdapter(providerId: string): TtsAdapter | undefined {
    return this.adapters.get(providerId);
  }

  /** 返回当前适配器实现的真实交付能力，供诊断与后续设置页展示。 */
  capabilitiesFor(providerId: string, model: string): TtsAdapterCapabilities | undefined {
    return this.adapters.get(providerId)?.capabilitiesFor({ model });
  }

  /**
   * Health check — verifies that at least one TTS provider is configured.
   *
   * V1 is a configuration check only (no live API call). A provider is
   * considered healthy when its adapter was successfully registered (i.e.
   * its config passed `buildTtsProviderConfig` validation in the wiring layer).
   * Actual API key validity is verified on first synthesis call.
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

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Synthesize a single text segment into audio chunks.
   *
   * The caller (TtsCoordinator) is responsible for:
   *   1. Sentence splitting — each synthesize() call receives ONE sentence.
   *   2. Voice resolution — request.voice is a fully-resolved TtsVoiceRef
   *      with voiceUri already populated (by apps/core before calling).
   *   3. Error handling — TtsClient emits TtsStreamEvent.error; the caller
   *      decides whether to retry, fall back, or surface to the user.
   *
   * TtsClient only:
   *   1. Cleans text (strip markdown/code/ACT markers).
   *   2. Looks up the adapter by request.providerId.
   *   3. Delegates to adapter.stream().
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

    // Build a normalized copy — never mutate the caller's request object.
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
