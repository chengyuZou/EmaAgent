// 定义 Vision 请求在下一次调用采用的体积、并发与超时上限。

import { defineSetting } from '@ema-agent/settings';
import { DEFAULT_VISION_LIMITS } from './requestValidation.js';
import type { VisionLimits } from './types.js';

export const visionSetting = defineSetting<VisionLimits>({
  key: 'vision.limits',
  kind: 'object',
  apply: 'nextOperation',
  defaultValue: DEFAULT_VISION_LIMITS,
  decode(value) {
    if (!isRecord(value)) return { ok: false };
    const merged = { ...DEFAULT_VISION_LIMITS, ...value };
    if (!integerInRange(merged.maxImages, 1, 8)) return { ok: false };
    if (!integerInRange(merged.maxBytesPerImage, 1024 * 1024, 20 * 1024 * 1024)) return { ok: false };
    if (!integerInRange(merged.maxTotalBytes, 1024 * 1024, 40 * 1024 * 1024)) return { ok: false };
    if (merged.maxBytesPerImage > merged.maxTotalBytes) return { ok: false };
    if (!integerInRange(merged.maxConcurrentGlobal, 1, 8)) return { ok: false };
    if (!integerInRange(merged.maxConcurrentPerProvider, 1, 4)) return { ok: false };
    if (merged.maxConcurrentPerProvider > merged.maxConcurrentGlobal) return { ok: false };
    if (!integerInRange(merged.maxQueuedRequests, 0, 128)) return { ok: false };
    if (!integerInRange(merged.timeoutMs, 5_000, 300_000)) return { ok: false };
    return { ok: true, value: merged as VisionLimits };
  },
  encode: value => value,
});

function integerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
