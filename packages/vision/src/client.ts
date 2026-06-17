import { Buffer } from 'node:buffer';
import type {
  AssistantBlock,
  LlmMessage,
  MessageContentPart,
} from '@ema-agent/contracts';
import { VisionError, classifyVisionError } from './errors.js';
import type {
  VisionExtractionResult,
  VisionImageInput,
  VisionLimits,
  VisionRequest,
  VisionSourceRef,
  VisionTask,
} from './types.js';
import {
  buildVisionExtractionPrompt,
  defaultMaxTokensForVisionTask,
} from './prompts.js';
import { parseVisionPayload } from './parse.js';

export type VisionLlmContentPart = MessageContentPart;

export interface VisionUnsupportedPart {
  index: number;
  part: MessageContentPart;
  reason: string;
}

export interface VisionLlmRequest {
  providerId: string;
  model: string;
  messages: LlmMessage[];
  toolChoice?: 'auto' | 'none' | { name: string };
  thinking?: { enabled: false };
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface VisionLlmCompletion {
  blocks: AssistantBlock[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface VisionLlmFacade {
  complete(request: VisionLlmRequest): Promise<VisionLlmCompletion>;
  warnUnsupportedParts(providerId: string, parts: VisionLlmContentPart[]): VisionUnsupportedPart[];
}

export interface VisionClientArgs {
  llm: VisionLlmFacade;
  limits?: Partial<VisionLimits>;
  /**
   * Advanced/testing hook. Production callers should use the default shared
   * limiter so separate VisionClient instances still obey one process-wide
   * concurrency budget.
   */
  limiter?: VisionConcurrencyLimiter;
}

export interface VisionConcurrencyLimiter {
  tryAcquire(
    providerId: string,
    maxGlobal: number,
    maxPerProvider: number,
  ): (() => void) | null;
}

export class VisionClient {
  private readonly llm: VisionLlmFacade;
  private readonly limits: VisionLimits;
  private readonly limiter: VisionConcurrencyLimiter;

  constructor(args: VisionClientArgs) {
    this.llm = args.llm;
    this.limits = { ...DEFAULT_LIMITS, ...args.limits };
    this.limiter = args.limiter ?? DEFAULT_LIMITER;
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
      const prompt = buildVisionExtractionPrompt({
        task: normalized.task,
        language: normalized.language,
        imageCount: normalized.inputs.length,
        customInstruction: normalized.prompt,
      });
      const parts: VisionLlmContentPart[] = [
        { type: 'text', text: prompt },
        ...normalized.inputs.map(inputToContentPart),
      ];

      let unsupported: VisionUnsupportedPart[];
      try {
        unsupported = this.llm.warnUnsupportedParts(normalized.providerId, parts);
      } catch (error) {
        throw classifyVisionError(error, meta, signalScope.timedOut());
      }

      if (unsupported.length > 0) {
        throw new VisionError(
          'vision/unsupported_input',
          `Provider "${normalized.providerId}" does not support this vision input`,
          { details: unsupported, meta: { ...meta, retryable: false } },
        );
      }

      const completion = await this.llm.complete({
        providerId: normalized.providerId,
        model: normalized.model,
        messages: [{ role: 'user', content: parts }],
        toolChoice: 'none',
        thinking: { enabled: false },
        maxTokens: normalized.maxTokens ?? defaultMaxTokensForVisionTask(normalized.task),
        temperature: normalized.temperature ?? 0,
        signal: signalScope.signal,
      });

      const rawText = collectText(completion);
      const parsed = parseVisionPayload(rawText, { mode: normalized.parseMode });

      return {
        ...(normalized.context ? { context: normalized.context } : {}),
        providerId: normalized.providerId,
        model: normalized.model,
        task: normalized.task,
        text: parsed.text,
        ...(parsed.markdown ? { markdown: parsed.markdown } : {}),
        blocks: parsed.blocks,
        sources: normalized.inputs.map(sourceForInput),
        usage: completion.usage,
        ...(parsed.warnings && parsed.warnings.length > 0 ? { warnings: parsed.warnings } : {}),
        rawText,
      };
    } catch (error) {
      throw classifyVisionError(error, meta, signalScope.timedOut());
    } finally {
      signalScope.dispose();
      release();
    }
  }

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

class VisionLimiter {
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

const DEFAULT_LIMITER = new VisionLimiter();

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

function inputToContentPart(input: VisionImageInput): VisionLlmContentPart {
  switch (input.kind) {
    case 'bytes':
      return {
        type: 'image_data',
        data: Buffer.from(input.bytes).toString('base64'),
        mimeType: input.mimeType,
        ...(input.name ? { name: input.name } : {}),
      };
    case 'base64':
      return {
        type: 'image_data',
        data: input.data,
        mimeType: input.mimeType,
        ...(input.name ? { name: input.name } : {}),
      };
    case 'url':
      return {
        type: 'image_url',
        url: input.url,
        ...(input.name ? { name: input.name } : {}),
      };
  }
}

function sourceForInput(input: VisionImageInput): VisionSourceRef {
  if (input.source) return input.source;
  switch (input.kind) {
    case 'url':
      return { url: input.url, label: input.name };
    case 'bytes':
    case 'base64':
      return { label: input.name };
  }
}

function collectText(completion: VisionLlmCompletion): string {
  return completion.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
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
