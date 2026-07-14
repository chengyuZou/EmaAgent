import { OpenAiVisionAdapter }    from './adapters/openai-vision.js';
import { AnthropicVisionAdapter } from './adapters/anthropic-vision.js';
import { GeminiVisionAdapter }    from './adapters/gemini-vision.js';
import type { VisionAdapter, VisionAdapterCall } from './adapters/base.js';
import { VisionError, classifyVisionError } from './errors.js';
import type {
  VisionExtractionResult,
  VisionImageInput,
  VisionLimits,
  VisionProbeResult,
  VisionProviderConfig,
  VisionRequest,
  VisionTask,
} from './types.js';
import type { VisionProtocol } from '@ema-agent/contracts';

export interface VisionConcurrencyLimiter {
  tryAcquire(
    providerId: string,
    maxGlobal: number,
    maxPerProvider: number,
  ): (() => void) | null;
}

export interface VisionRouterArgs {
  configs: VisionProviderConfig[];
  limits?: Partial<VisionLimits>;
  adapterOverrides?: ReadonlyMap<string, VisionAdapter>;
  limiter?: VisionConcurrencyLimiter;
}

function createAdapter(config: VisionProviderConfig): VisionAdapter {
  switch (config.protocol) {
    case 'openai-vision':
      return new OpenAiVisionAdapter(config);
    case 'anthropic-vision':
      return new AnthropicVisionAdapter(config);
    case 'gemini-vision':
      return new GeminiVisionAdapter(config);
    default:
      throw new VisionError('vision/not_configured', `Unsupported vision protocol "${config.protocol}"`, {
        meta: { providerId: config.id, retryable: false },
      });
  }
}

function notConfigured(providerId: string): VisionError {
  return new VisionError('vision/not_configured', `Vision provider "${providerId}" is not configured`, {
    meta: { providerId, retryable: false },
  });
}

const DEFAULT_LIMITS: VisionLimits = {
  maxImages: 8,
  maxBytesPerImage: 10 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxConcurrentGlobal: 4,
  maxConcurrentPerProvider: 2,
  timeoutMs: 60_000,
};

type NormalizedVisionRequest = Omit<VisionRequest, 'task' | 'parseMode'> & {
  task: VisionTask;
  parseMode: 'strict' | 'best_effort';
};

export class VisionLimiter implements VisionConcurrencyLimiter {
  private total = 0;
  private readonly byProvider = new Map<string, number>();

  tryAcquire(
    providerId: string,
    maxGlobal: number,
    maxPerProvider: number,
  ): (() => void) | null {
    const currentProvider = this.byProvider.get(providerId) ?? 0;
    if (this.total >= maxGlobal || currentProvider >= maxPerProvider) return null;

    this.total++;
    this.byProvider.set(providerId, currentProvider + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total = Math.max(0, this.total - 1);
      const nextProvider = Math.max(0, (this.byProvider.get(providerId) ?? 1) - 1);
      if (nextProvider === 0) this.byProvider.delete(providerId);
      else this.byProvider.set(providerId, nextProvider);
    };
  }
}

/**
 * Single Vision runtime facade.
 *
 * Construct once in apps/core wiring and share through AppBindings. The router
 * stores provider config, adapter instances, and lightweight concurrency state.
 * Per-call image payloads, prompts, parse state, and AbortControllers remain
 * local to extract(), so concurrent chat / attachment / knowledge calls cannot
 * overwrite each other.
 */
export class VisionRouter {
  private adapters = new Map<string, VisionAdapter>();
  private configs = new Map<string, VisionProviderConfig>();
  private readonly adapterOverrides?: ReadonlyMap<string, VisionAdapter>;
  private readonly limiter: VisionConcurrencyLimiter;
  private readonly limits: VisionLimits;

  constructor(args: VisionRouterArgs) {
    this.adapterOverrides = args.adapterOverrides;
    this.limiter = args.limiter ?? new VisionLimiter();
    this.limits = { ...DEFAULT_LIMITS, ...args.limits };

    for (const config of args.configs) {
      this.configs.set(config.id, config);
      this.adapters.set(config.id, this.createAdapterFor(config));
    }
  }

  async extract(request: VisionRequest): Promise<VisionExtractionResult> {
    const normalized = normalizeRequest(request);
    const limits = { ...this.limits, ...normalized.limits };
    const meta = {
      providerId: normalized.providerId,
      model: normalized.model,
      task: normalized.task,
      context: normalized.context,
    };

    validateRequest(normalized, limits);

    const adapter = this.adapters.get(normalized.providerId);
    if (!adapter || !this.configs.has(normalized.providerId)) {
      throw notConfigured(normalized.providerId);
    }

    const release = this.limiter.tryAcquire(
      normalized.providerId,
      limits.maxConcurrentGlobal,
      limits.maxConcurrentPerProvider,
    );
    if (!release) {
      throw new VisionError('vision/concurrency_limited', 'Vision concurrency limit reached', {
        meta: { ...meta, retryable: true },
      });
    }

    const signalScope = createScopedSignal(normalized.signal, limits.timeoutMs);
    try {
      return await adapter.extract({
        ...normalized,
        signal: signalScope.signal,
      });
    } catch (error) {
      throw classifyVisionError(error, meta, signalScope.timedOut());
    } finally {
      signalScope.dispose();
      release();
    }
  }

  async probe(providerId: string, model?: string, signal?: AbortSignal): Promise<VisionProbeResult> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) return { ok: false, error: `vision/not_configured: no config registered for "${providerId}"` };

    const probeModel = model ?? this.defaultModelFor(providerId);
    if (!probeModel) return { ok: false, error: `vision/model_not_configured: no model for "${providerId}"` };
    if (!adapter.probe) return { ok: false, error: 'probe not supported by this adapter' };

    return adapter.probe(probeModel, signal);
  }

  getProtocol(providerId: string): VisionProtocol | undefined {
    return this.configs.get(providerId)?.protocol;
  }

  /** 使用完整 Provider 快照替换运行时 Adapter。 */
  reload(configs: VisionProviderConfig[]): void {
    const nextConfigs = new Map<string, VisionProviderConfig>();
    const nextAdapters = new Map<string, VisionAdapter>();
    for (const config of configs) {
      nextConfigs.set(config.id, config);
      nextAdapters.set(config.id, this.createAdapterFor(config));
    }
    this.configs = nextConfigs;
    this.adapters = nextAdapters;
  }

  upsertConfig(config: VisionProviderConfig): void {
    this.configs.set(config.id, config);
    this.adapters.set(config.id, this.createAdapterFor(config));
  }

  removeConfig(providerId: string): void {
    this.configs.delete(providerId);
    this.adapters.delete(providerId);
  }

  firstProviderId(): string | undefined {
    return this.configs.keys().next().value;
  }

  defaultModelFor(providerId: string): string | undefined {
    return this.configs.get(providerId)?.defaultModel;
  }

  private createAdapterFor(config: VisionProviderConfig): VisionAdapter {
    return this.adapterOverrides?.get(config.id) ?? createAdapter(config);
  }
}

function normalizeRequest(request: VisionRequest): NormalizedVisionRequest {
  return {
    ...request,
    task: request.task ?? 'auto',
    parseMode: request.parseMode ?? 'best_effort',
  };
}

function validateRequest(request: NormalizedVisionRequest, limits: VisionLimits): void {
  if (!request.providerId.trim()) {
    throw new VisionError('vision/invalid_request', 'providerId is required', {
      meta: { task: request.task, context: request.context },
    });
  }
  if (!request.model.trim()) {
    throw new VisionError('vision/invalid_request', 'model is required', {
      meta: { providerId: request.providerId, task: request.task, context: request.context },
    });
  }
  if (request.inputs.length === 0) {
    throw new VisionError('vision/invalid_request', 'Vision extraction requires at least one image input', {
      meta: { providerId: request.providerId, model: request.model, task: request.task, context: request.context },
    });
  }
  if (request.inputs.length > limits.maxImages) {
    throw new VisionError('vision/payload_too_large', `Vision input count exceeds maxImages=${limits.maxImages}`, {
      meta: { providerId: request.providerId, model: request.model, task: request.task, context: request.context },
      details: { imageCount: request.inputs.length, maxImages: limits.maxImages },
    });
  }

  let totalBytes = 0;
  for (const input of request.inputs) {
    const size = inputSizeBytes(input);
    if (size > limits.maxBytesPerImage) {
      throw new VisionError('vision/payload_too_large', `Vision image exceeds maxBytesPerImage=${limits.maxBytesPerImage}`, {
        meta: { providerId: request.providerId, model: request.model, task: request.task, context: request.context },
        details: { size, maxBytesPerImage: limits.maxBytesPerImage, source: input.source },
      });
    }
    totalBytes += size;
  }

  if (totalBytes > limits.maxTotalBytes) {
    throw new VisionError('vision/payload_too_large', `Vision payload exceeds maxTotalBytes=${limits.maxTotalBytes}`, {
      meta: { providerId: request.providerId, model: request.model, task: request.task, context: request.context },
      details: { totalBytes, maxTotalBytes: limits.maxTotalBytes },
    });
  }
}

function inputSizeBytes(input: VisionImageInput): number {
  switch (input.kind) {
    case 'bytes':
      return input.bytes.byteLength;
    case 'base64':
      return estimateBase64Bytes(input.data);
    case 'url':
      return 0;
  }
}

function estimateBase64Bytes(data: string): number {
  const clean = data.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
  if (clean.length === 0) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(clean.length * 0.75) - padding);
}

function createScopedSignal(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let didTimeout = false;

  const onAbort = (): void => {
    controller.abort(upstream?.reason);
  };

  if (upstream?.aborted) {
    controller.abort(upstream.reason);
  } else {
    upstream?.addEventListener('abort', onAbort, { once: true });
  }

  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error('vision/timeout'));
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    dispose: () => {
      clearTimeout(timer);
      upstream?.removeEventListener('abort', onAbort);
    },
  };
}
