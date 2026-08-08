// 定义下一根 Turn 使用的自动压缩预算与失败熔断设置。

import { defineSetting } from '@ema-agent/settings';
import {
  DEFAULT_COMPACT_SETTINGS,
  type CompactSettings,
} from './types.js';

export const compactSetting = defineSetting<CompactSettings>({
  key: 'context.compact',
  kind: 'object',
  apply: 'nextTurn',
  defaultValue: DEFAULT_COMPACT_SETTINGS,
  decode(value) {
    if (!isRecord(value)) return { ok: false };
    const merged = { ...DEFAULT_COMPACT_SETTINGS, ...value };
    if (typeof merged.enabled !== 'boolean') return { ok: false };
    if (!integerInRange(merged.bufferTokens, 1_000, 64_000)) return { ok: false };
    if (!integerInRange(merged.defaultReservedOutputTokens, 1_000, 64_000)) return { ok: false };
    if (!integerInRange(merged.maximumReservedOutputTokens, 1_000, 128_000)) return { ok: false };
    if (merged.defaultReservedOutputTokens > merged.maximumReservedOutputTokens) return { ok: false };
    if (!integerInRange(merged.keepRecentToolResults, 1, 32)) return { ok: false };
    if (!integerInRange(merged.maximumConsecutiveFailures, 1, 10)) return { ok: false };
    return { ok: true, value: merged as CompactSettings };
  },
});

function integerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
