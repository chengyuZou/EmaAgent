// 定义后台 Shell 后续新进程采用的并发数和最长运行时间。

import { defineSetting } from '@ema-agent/settings';
import type { BackgroundProcessSettings } from './types.js';

export const DEFAULT_BACKGROUND_PROCESS_SETTINGS: BackgroundProcessSettings = {
  maxConcurrent: 2,
  maxRuntimeHours: 24,
};

export const backgroundProcessSetting = defineSetting<BackgroundProcessSettings>({
  key: 'tools.backgroundProcess',
  kind: 'object',
  apply: 'nextOperation',
  defaultValue: DEFAULT_BACKGROUND_PROCESS_SETTINGS,
  decode(value) {
    if (!isRecord(value)) return { ok: false };
    const merged = { ...DEFAULT_BACKGROUND_PROCESS_SETTINGS, ...value };
    if (!integerInRange(merged.maxConcurrent, 1, 8)) return { ok: false };
    if (!integerInRange(merged.maxRuntimeHours, 1, 168)) return { ok: false };
    return { ok: true, value: merged as BackgroundProcessSettings };
  },
});

function integerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
