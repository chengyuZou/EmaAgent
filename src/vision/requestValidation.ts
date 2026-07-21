// 规范化 Vision 请求并验证图片体积、数量、并发和超时限制。
import { VisionError } from './errors.js';
import type { VisionImageInput, VisionLimits, VisionRequest, VisionTask } from './types.js';

export type NormalizedVisionRequest = Omit<VisionRequest, 'task' | 'parseMode'> & {
  task: VisionTask;
  parseMode: 'strict' | 'best_effort';
};

export const DEFAULT_VISION_LIMITS: Readonly<VisionLimits> = Object.freeze({
  maxImages: 8,
  maxBytesPerImage: 10 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxConcurrentGlobal: 4,
  maxConcurrentPerProvider: 2,
  maxQueuedRequests: 64,
  timeoutMs: 60_000,
});

export function normalizeVisionRequest(request: VisionRequest): NormalizedVisionRequest {
  return {
    ...request,
    task: request.task ?? 'auto',
    parseMode: request.parseMode ?? 'best_effort',
  };
}

export function resolveVisionLimits(
  base: VisionLimits,
  requested?: Partial<VisionLimits>,
): VisionLimits {
  if (!requested) return base;
  // 单次调用只能收紧限制，不能绕过 Runtime/Settings 给出的运行时硬上限。
  const maxConcurrentGlobal = Math.min(
    base.maxConcurrentGlobal,
    requested.maxConcurrentGlobal ?? base.maxConcurrentGlobal,
  );
  const maxConcurrentPerProvider = Math.min(
    base.maxConcurrentPerProvider,
    requested.maxConcurrentPerProvider ?? base.maxConcurrentPerProvider,
    maxConcurrentGlobal,
  );
  return {
    maxImages: Math.min(base.maxImages, requested.maxImages ?? base.maxImages),
    maxBytesPerImage: Math.min(base.maxBytesPerImage, requested.maxBytesPerImage ?? base.maxBytesPerImage),
    maxTotalBytes: Math.min(base.maxTotalBytes, requested.maxTotalBytes ?? base.maxTotalBytes),
    maxConcurrentGlobal,
    maxConcurrentPerProvider,
    maxQueuedRequests: Math.min(base.maxQueuedRequests, requested.maxQueuedRequests ?? base.maxQueuedRequests),
    timeoutMs: Math.min(base.timeoutMs, requested.timeoutMs ?? base.timeoutMs),
  };
}

export function validateVisionRequest(request: NormalizedVisionRequest, limits: VisionLimits): void {
  const errorContext = {
    providerId: request.providerId,
    model: request.model,
    task: request.task,
    invocationContext: request.context,
  };
  if (!request.providerId.trim()) {
    throw new VisionError('vision/invalid_request', 'providerId is required', errorContext);
  }
  if (!request.model.trim()) {
    throw new VisionError('vision/invalid_request', 'model is required', errorContext);
  }
  if (request.inputs.length === 0) {
    throw new VisionError(
      'vision/invalid_request',
      'Vision extraction requires at least one image input',
      errorContext,
    );
  }
  if (request.inputs.length > limits.maxImages) {
    throw new VisionError(
      'vision/payload_too_large',
      `Vision input count exceeds maxImages=${limits.maxImages}`,
      {
        ...errorContext,
        details: { imageCount: request.inputs.length, maxImages: limits.maxImages },
      },
    );
  }

  let totalBytes = 0;
  for (const input of request.inputs) {
    const imageBytes = inputSizeBytes(input);
    if (imageBytes > limits.maxBytesPerImage) {
      throw new VisionError(
        'vision/payload_too_large',
        `Vision image exceeds maxBytesPerImage=${limits.maxBytesPerImage}`,
        {
          ...errorContext,
          details: {
            imageBytes,
            maxBytesPerImage: limits.maxBytesPerImage,
            source: input.source,
          },
        },
      );
    }
    totalBytes += imageBytes;
  }

  if (totalBytes > limits.maxTotalBytes) {
    throw new VisionError(
      'vision/payload_too_large',
      `Vision payload exceeds maxTotalBytes=${limits.maxTotalBytes}`,
      {
        ...errorContext,
        details: { totalBytes, maxTotalBytes: limits.maxTotalBytes },
      },
    );
  }
}

export function validateVisionLimits(limits: VisionLimits): void {
  const positiveIntegers: Array<keyof VisionLimits> = [
    'maxImages',
    'maxBytesPerImage',
    'maxTotalBytes',
    'maxConcurrentGlobal',
    'maxConcurrentPerProvider',
    'timeoutMs',
  ];
  for (const key of positiveIntegers) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new VisionError('vision/invalid_request', `${key} must be a positive safe integer`);
    }
  }
  if (!Number.isSafeInteger(limits.maxQueuedRequests) || limits.maxQueuedRequests < 0) {
    throw new VisionError(
      'vision/invalid_request',
      'maxQueuedRequests must be a non-negative safe integer',
    );
  }
  if (limits.maxConcurrentPerProvider > limits.maxConcurrentGlobal) {
    throw new VisionError(
      'vision/invalid_request',
      'maxConcurrentPerProvider must not exceed maxConcurrentGlobal',
    );
  }
}

function inputSizeBytes(input: VisionImageInput): number {
  switch (input.kind) {
    case 'bytes': return input.bytes.byteLength;
    case 'base64': return estimateBase64Bytes(input.data);
    case 'url': return 0;
  }
}

function estimateBase64Bytes(data: string): number {
  const clean = data.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
  if (clean.length === 0) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(clean.length * 0.75) - padding);
}
