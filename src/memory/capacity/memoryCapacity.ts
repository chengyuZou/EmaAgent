import {
  MEMORY_STORAGE_MAX_BYTES,
  MEMORY_STORAGE_WARNING_BYTES,
} from './limits.js';

export type MemoryCapacityLevel = 'normal' | 'warning' | 'limitExceeded';

export interface MemoryCapacity {
  readonly level: MemoryCapacityLevel;
  readonly usedBytes: number;
  readonly maxBytes: number;
  readonly warningAtBytes: number;
  readonly remainingBytes: number;
}

export function evaluateMemoryCapacity(usedBytes: number): MemoryCapacity {
  const level: MemoryCapacityLevel = usedBytes >= MEMORY_STORAGE_MAX_BYTES
    ? 'limitExceeded'
    : usedBytes >= MEMORY_STORAGE_WARNING_BYTES
      ? 'warning'
      : 'normal';
  return {
    level,
    usedBytes,
    maxBytes: MEMORY_STORAGE_MAX_BYTES,
    warningAtBytes: MEMORY_STORAGE_WARNING_BYTES,
    remainingBytes: Math.max(0, MEMORY_STORAGE_MAX_BYTES - usedBytes),
  };
}
