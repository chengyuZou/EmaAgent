// 把 Memory 当前字节数投影为用户可见的存储状态.

import type { SettingsStore } from '@ema-agent/settings';
import { memoryStorageMaxBytesSetting } from '../settings.js';

const WARNING_RATIO = 0.8;

export type MemoryStorageLevel =
  | 'normal'
  | 'warning'
  | 'limitExceeded';

export interface MemoryStorageLimit {
  readonly maxBytes: number;
  readonly warningAtBytes: number;
}

export interface MemoryStorageStatus extends MemoryStorageLimit {
  readonly level: MemoryStorageLevel;
  readonly usedBytes: number;
  readonly remainingBytes: number;
}

export const DEFAULT_MEMORY_STORAGE_LIMIT: MemoryStorageLimit =
  createMemoryStorageLimit(memoryStorageMaxBytesSetting.defaultValue);

export function readMemoryStorageLimit(
  store: SettingsStore,
): MemoryStorageLimit {
  return createMemoryStorageLimit(store.get(memoryStorageMaxBytesSetting));
}

export function evaluateMemoryStorage(
  usedBytes: number,
  limit: MemoryStorageLimit,
): MemoryStorageStatus {
  const level: MemoryStorageLevel = usedBytes >= limit.maxBytes
    ? 'limitExceeded'
    : usedBytes >= limit.warningAtBytes
      ? 'warning'
      : 'normal';

  return {
    ...limit,
    level,
    usedBytes,
    remainingBytes: Math.max(0, limit.maxBytes - usedBytes),
  };
}

function createMemoryStorageLimit(maxBytes: number): MemoryStorageLimit {
  return {
    maxBytes,
    warningAtBytes: Math.floor(maxBytes * WARNING_RATIO),
  };
}
