// 定义 Memory 模型、维护和逻辑存储预算的用户可调安全范围。

import { defineSetting } from '@ema-agent/settings';

export interface MemoryModelRef {
  providerConfigId: string;
  model: string;
}

export interface MemoryModelSettings {
  embed?: MemoryModelRef;
  rerank?: MemoryModelRef;
}

export interface MemoryMaintenanceSettings {
  decayAfterDays: number;
  decayAmount: number;
  coldDeleteAfterDays: number;
}

export interface MemoryStorageSettings {
  maxBytes: number;
}

export interface MemoryUserSettingsSnapshot {
  models: MemoryModelSettings;
  maintenance: MemoryMaintenanceSettings;
  storage: MemoryStorageSettings;
}

export const DEFAULT_MEMORY_MAINTENANCE_SETTINGS: MemoryMaintenanceSettings = {
  decayAfterDays: 30,
  decayAmount: 10,
  coldDeleteAfterDays: 90,
};

export const DEFAULT_MEMORY_STORAGE_SETTINGS: MemoryStorageSettings = {
  maxBytes: 512 * 1024 * 1024,
};

export const memoryModelsSetting = defineSetting<MemoryModelSettings>({
  key: 'memory.models',
  kind: 'object',
  apply: 'nextOperation',
  defaultValue: {},
  decode(value) {
    if (!isRecord(value)) return { ok: false };
    const embed = decodeModelRef(value['embed']);
    const rerank = decodeModelRef(value['rerank']);
    if (embed === null || rerank === null) return { ok: false };
    return {
      ok: true,
      value: {
        ...(embed ? { embed } : {}),
        ...(rerank ? { rerank } : {}),
      },
    };
  },
  encode: value => value,
});

export const memoryMaintenanceSetting = defineSetting<MemoryMaintenanceSettings>({
  key: 'memory.maintenance',
  kind: 'object',
  apply: 'nextOperation',
  defaultValue: DEFAULT_MEMORY_MAINTENANCE_SETTINGS,
  decode(value) {
    if (!isRecord(value)) return { ok: false };
    const merged = { ...DEFAULT_MEMORY_MAINTENANCE_SETTINGS, ...value };
    if (!integerInRange(merged.decayAfterDays, 7, 3_650)) return { ok: false };
    if (!integerInRange(merged.decayAmount, 1, 50)) return { ok: false };
    if (!integerInRange(merged.coldDeleteAfterDays, 30, 3_650)) return { ok: false };
    return {
      ok: true,
      value: {
        decayAfterDays: merged.decayAfterDays,
        decayAmount: merged.decayAmount,
        coldDeleteAfterDays: merged.coldDeleteAfterDays,
      },
    };
  },
  encode: value => value,
});

export const memoryStorageSetting = defineSetting<MemoryStorageSettings>({
  key: 'memory.storage',
  kind: 'object',
  apply: 'nextOperation',
  defaultValue: DEFAULT_MEMORY_STORAGE_SETTINGS,
  decode(value) {
    if (!isRecord(value)) return { ok: false };
    const merged = { ...DEFAULT_MEMORY_STORAGE_SETTINGS, ...value };
    if (!integerInRange(
      merged.maxBytes,
      64 * 1024 * 1024,
      8 * 1024 * 1024 * 1024,
    )) {
      return { ok: false };
    }
    return { ok: true, value: { maxBytes: merged.maxBytes } };
  },
  encode: value => value,
});

function decodeModelRef(value: unknown): MemoryModelRef | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return null;
  const providerConfigId = value['providerConfigId'];
  const model = value['model'];
  if (typeof providerConfigId !== 'string' || providerConfigId.length === 0) return null;
  if (typeof model !== 'string' || model.length === 0) return null;
  return { providerConfigId, model };
}

function integerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
