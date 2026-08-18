// Memory 维护与逻辑存储预算的用户可调安全范围。
// 模型选择(embed/rerank)已迁出到 model_bindings(memory-embed/memory-rerank),
// 这里只留标量设置;设置接口与字段统一在此文件,拆细为一字段一 key。

import type { SettingsStore } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

export interface MemoryMaintenanceSettings {
  decayAfterDays: number;
  decayAmount: number;
  coldDeleteAfterDays: number;
}

export interface MemoryStorageSettings {
  maxBytes: number;
}

export interface MemoryUserSettingsSnapshot {
  maintenance: MemoryMaintenanceSettings;
  storage: MemoryStorageSettings;
}

export const memoryDecayAfterDaysSetting = defineSetting<number>({
  key: 'memory.maintenance.decayAfterDays',
  apply: 'nextOperation',
  defaultValue: 30,
  schema: z.number().int().min(7).max(3_650),
});

export const memoryDecayAmountSetting = defineSetting<number>({
  key: 'memory.maintenance.decayAmount',
  apply: 'nextOperation',
  defaultValue: 10,
  schema: z.number().int().min(1).max(50),
});

export const memoryColdDeleteAfterDaysSetting = defineSetting<number>({
  key: 'memory.maintenance.coldDeleteAfterDays',
  apply: 'nextOperation',
  defaultValue: 90,
  schema: z.number().int().min(30).max(3_650),
});

export const memoryStorageMaxBytesSetting = defineSetting<number>({
  key: 'memory.storage.maxBytes',
  apply: 'nextOperation',
  defaultValue: 512 * 1024 * 1024,
  schema: z.number().int().min(64 * 1024 * 1024).max(8 * 1024 * 1024 * 1024),
});

/** 整组默认快照(供消费方默认参数与测试),单一事实源是各 setting 的 defaultValue。 */
export const DEFAULT_MEMORY_MAINTENANCE_SETTINGS: MemoryMaintenanceSettings = {
  decayAfterDays: memoryDecayAfterDaysSetting.defaultValue,
  decayAmount: memoryDecayAmountSetting.defaultValue,
  coldDeleteAfterDays: memoryColdDeleteAfterDaysSetting.defaultValue,
};

export const DEFAULT_MEMORY_STORAGE_SETTINGS: MemoryStorageSettings = {
  maxBytes: memoryStorageMaxBytesSetting.defaultValue,
};

/** 聚合读取 memory 标量设置快照(坏值/缺失自动回落默认)。 */
export function readMemorySettings(store: SettingsStore): MemoryUserSettingsSnapshot {
  return {
    maintenance: {
      decayAfterDays: store.get(memoryDecayAfterDaysSetting),
      decayAmount: store.get(memoryDecayAmountSetting),
      coldDeleteAfterDays: store.get(memoryColdDeleteAfterDaysSetting),
    },
    storage: {
      maxBytes: store.get(memoryStorageMaxBytesSetting),
    },
  };
}
