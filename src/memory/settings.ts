// 定义 Memory 物理存储上限与单次业务预算.

import type { SettingGroup, SettingsStore } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

export const memoryStorageMaxBytesSetting = defineSetting({
  key: 'memory.storage.maxBytes',
  apply: 'nextOperation',
  defaultValue: 1024 * 1024 * 1024,
  schema: z.number().int().min(500 * 1024 * 1024).max(5 * 1024 * 1024 * 1024),
});

export const memoryWorkHistoryRetentionDaysSetting = defineSetting({
  key: 'memory.work.historyRetentionDays',
  apply: 'nextOperation',
  defaultValue: 90,
  schema: z.number().int().min(30).max(180),
  group: 'memory.lifecycle',
});

export const memoryRelationshipHistoryActiveDaysSetting = defineSetting({
  key: 'memory.relationship.historyActiveDays',
  apply: 'nextOperation',
  defaultValue: 180,
  schema: z.number().int().min(30).max(180),
  group: 'memory.lifecycle',
});

// ── 运行参数 memory.jobs(提取并发 / 整合心跳) ─────────────────────────────────

export const memoryExtractionConcurrencySetting = defineSetting({
  key: 'memory.jobs.extractionConcurrency',
  apply: 'nextOperation',
  defaultValue: 4,
  schema: z.number().int().min(1).max(32),
  group: 'memory.jobs',
});

export const memoryHeartbeatSecondsSetting = defineSetting({
  key: 'memory.jobs.heartbeatSeconds',
  apply: 'nextOperation',
  defaultValue: 30,
  schema: z.number().int().min(30).max(600),
  group: 'memory.jobs',
});

export const memoryConsolidationCooldownHoursSetting = defineSetting({
  key: 'memory.jobs.consolidationCooldownHours',
  apply: 'nextOperation',
  defaultValue: 6,
  schema: z.number().int().min(0).max(24),
  group: 'memory.jobs',
});

export const MEMORY_SETTINGS = [
  memoryStorageMaxBytesSetting,
  memoryWorkHistoryRetentionDaysSetting,
  memoryRelationshipHistoryActiveDaysSetting,
  memoryExtractionConcurrencySetting,
  memoryHeartbeatSecondsSetting,
  memoryConsolidationCooldownHoursSetting,
] as const;

export const memoryLifecycleGroup: SettingGroup = {
  id: 'memory.lifecycle',
  definitions: [
    memoryWorkHistoryRetentionDaysSetting,
    memoryRelationshipHistoryActiveDaysSetting,
  ],
  schema: z.object({
    'memory.work.historyRetentionDays': z.number(),
    'memory.relationship.historyActiveDays': z.number(),
  }),
};

// ── memory.jobs 组与聚合读取 ──────────────────────────────────────────────────
// 组级 refine 只做最低护栏(两参数无数学上的跨字段约束)。

export const memoryJobsGroup: SettingGroup = {
  id: 'memory.jobs',
  definitions: [
    memoryExtractionConcurrencySetting,
    memoryHeartbeatSecondsSetting,
    memoryConsolidationCooldownHoursSetting,
  ],
  schema: z.object({
    'memory.jobs.extractionConcurrency': z.number(),
    'memory.jobs.heartbeatSeconds': z.number(),
    'memory.jobs.consolidationCooldownHours': z.number(),
  }),
};

export interface MemoryJobsSettings {
  /** 提取 Job 并发上限。 */
  readonly extractionConcurrency: number;
  /** 整合心跳间隔秒(失去所有权即中止)。 */
  readonly heartbeatSeconds: number;
  /** 整合冷却小时数(0 = 关闭冷却);冷却期内该轨整合 Job 不被认领。 */
  readonly consolidationCooldownHours: number;
}

export interface MemoryLifecycleSettings {
  /** Work 历史按最后修改时间保留的墙钟日数。 */
  readonly workHistoryRetentionDays: number;
  /** 每个角色保留的历史活跃日数量。 */
  readonly relationshipHistoryActiveDays: number;
}

export const DEFAULT_MEMORY_LIFECYCLE_SETTINGS: MemoryLifecycleSettings = {
  workHistoryRetentionDays: memoryWorkHistoryRetentionDaysSetting.defaultValue,
  relationshipHistoryActiveDays: memoryRelationshipHistoryActiveDaysSetting.defaultValue,
};

export function readMemoryLifecycleSettings(
  store: SettingsStore,
): MemoryLifecycleSettings {
  return {
    workHistoryRetentionDays: store.get(memoryWorkHistoryRetentionDaysSetting),
    relationshipHistoryActiveDays: store.get(memoryRelationshipHistoryActiveDaysSetting),
  };
}

/** 运行参数默认值;单一事实源是各 setting 的 defaultValue。 */
export const DEFAULT_MEMORY_JOBS_SETTINGS: MemoryJobsSettings = {
  extractionConcurrency: memoryExtractionConcurrencySetting.defaultValue,
  heartbeatSeconds: memoryHeartbeatSecondsSetting.defaultValue,
  consolidationCooldownHours: memoryConsolidationCooldownHoursSetting.defaultValue,
};

/** 一次性读取 Memory 运行参数;坏值/缺失由 SettingsStore 回落默认。 */
export function readMemoryJobsSettings(store: SettingsStore): MemoryJobsSettings {
  return {
    extractionConcurrency: store.get(memoryExtractionConcurrencySetting),
    heartbeatSeconds: store.get(memoryHeartbeatSecondsSetting),
    consolidationCooldownHours: store.get(memoryConsolidationCooldownHoursSetting),
  };
}
