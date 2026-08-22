// 定义 Memory 物理存储上限与单次业务预算.

import type { SettingGroup, SettingsStore } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

export const memoryStorageMaxBytesSetting = defineSetting<number>({
  key: 'memory.storage.maxBytes',
  apply: 'nextOperation',
  defaultValue: 256 * 1024 * 1024,
  schema: z.number().int().min(16 * 1024 * 1024).max(4 * 1024 * 1024 * 1024),
});

export const memoryWorkHistoryRetentionDaysSetting = defineSetting<number>({
  key: 'memory.work.historyRetentionDays',
  apply: 'nextOperation',
  defaultValue: 90,
  schema: z.number().int().min(1).max(3_650),
  group: 'memory.lifecycle',
});

export const memoryRelationshipHistoryActiveDaysSetting = defineSetting<number>({
  key: 'memory.relationship.historyActiveDays',
  apply: 'nextOperation',
  defaultValue: 180,
  schema: z.number().int().min(1).max(3_650),
  group: 'memory.lifecycle',
});

export const memorySummaryTokensSetting = defineSetting<number>({
  key: 'memory.budgets.summaryTokens',
  apply: 'nextTurn',
  defaultValue: 2_500,
  schema: z.number().int().min(100).max(20_000),
  group: 'memory.budgets',
});

export const memoryCoreFileBytesSetting = defineSetting<number>({
  key: 'memory.budgets.coreMemoryFileBytes',
  apply: 'nextOperation',
  defaultValue: 128 * 1024,
  schema: z.number().int().min(16 * 1024).max(8 * 1024 * 1024),
  group: 'memory.budgets',
});

export const memoryTopicFileBytesSetting = defineSetting<number>({
  key: 'memory.budgets.topicFileBytes',
  apply: 'nextOperation',
  defaultValue: 256 * 1024,
  schema: z.number().int().min(16 * 1024).max(16 * 1024 * 1024),
  group: 'memory.budgets',
});

export const memoryHistoryFileBytesSetting = defineSetting<number>({
  key: 'memory.budgets.historyFileBytes',
  apply: 'nextOperation',
  defaultValue: 256 * 1024,
  schema: z.number().int().min(16 * 1024).max(16 * 1024 * 1024),
  group: 'memory.budgets',
});

export const memoryTurnEvidenceFileBytesSetting = defineSetting<number>({
  key: 'memory.budgets.turnEvidenceFileBytes',
  apply: 'nextOperation',
  defaultValue: 64 * 1024,
  schema: z.number().int().min(4 * 1024).max(4 * 1024 * 1024),
  group: 'memory.budgets',
});

export const memoryTurnEvidenceFilesSetting = defineSetting<number>({
  key: 'memory.budgets.turnEvidenceFiles',
  apply: 'nextOperation',
  defaultValue: 200,
  schema: z.number().int().min(10).max(2_000),
  group: 'memory.budgets',
});

export const memoryConsolidationItemsSetting = defineSetting<number>({
  key: 'memory.budgets.consolidationItems',
  apply: 'nextOperation',
  defaultValue: 256,
  schema: z.number().int().min(1).max(4_096),
  group: 'memory.budgets',
});

export const memoryConsolidationInputBytesSetting = defineSetting<number>({
  key: 'memory.budgets.consolidationInputBytes',
  apply: 'nextOperation',
  defaultValue: 2 * 1024 * 1024,
  schema: z.number().int().min(256 * 1024).max(64 * 1024 * 1024),
  group: 'memory.budgets',
});

export const memoryGitDiffBytesSetting = defineSetting<number>({
  key: 'memory.budgets.gitDiffBytes',
  apply: 'nextOperation',
  defaultValue: 4 * 1024 * 1024,
  schema: z.number().int().min(64 * 1024).max(64 * 1024 * 1024),
  group: 'memory.budgets',
});

// ── 运行参数 memory.jobs(提取并发 / 整合心跳) ─────────────────────────────────
// 各自有 zod 范围(单字段限制);真正的跨字段联合限制在 memory.budgets 组
// (gitDiff/turnEvidence 都 ≤ consolidationInputBytes)。

export const memoryExtractionConcurrencySetting = defineSetting<number>({
  key: 'memory.jobs.extractionConcurrency',
  apply: 'nextOperation',
  defaultValue: 4,
  schema: z.number().int().min(1).max(32),
  group: 'memory.jobs',
});

export const memoryHeartbeatSecondsSetting = defineSetting<number>({
  key: 'memory.jobs.heartbeatSeconds',
  apply: 'nextOperation',
  defaultValue: 30,
  schema: z.number().int().min(5).max(600),
  group: 'memory.jobs',
});

export const memoryConsolidationCooldownHoursSetting = defineSetting<number>({
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
  memorySummaryTokensSetting,
  memoryCoreFileBytesSetting,
  memoryTopicFileBytesSetting,
  memoryHistoryFileBytesSetting,
  memoryTurnEvidenceFileBytesSetting,
  memoryTurnEvidenceFilesSetting,
  memoryConsolidationItemsSetting,
  memoryConsolidationInputBytesSetting,
  memoryGitDiffBytesSetting,
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

export const memoryBudgetsGroup: SettingGroup = {
  id: 'memory.budgets',
  definitions: MEMORY_SETTINGS.filter(
    (definition) => definition.group === 'memory.budgets',
  ),
  schema: z
    .object({
      'memory.budgets.summaryTokens': z.number(),
      'memory.budgets.coreMemoryFileBytes': z.number(),
      'memory.budgets.topicFileBytes': z.number(),
      'memory.budgets.historyFileBytes': z.number(),
      'memory.budgets.turnEvidenceFileBytes': z.number(),
      'memory.budgets.turnEvidenceFiles': z.number(),
      'memory.budgets.consolidationItems': z.number(),
      'memory.budgets.consolidationInputBytes': z.number(),
      'memory.budgets.gitDiffBytes': z.number(),
    })
    .refine(
      (values) => (
        values['memory.budgets.turnEvidenceFileBytes']
        <= values['memory.budgets.consolidationInputBytes']
      ),
      {
        message: 'turnEvidenceFileBytes 不能大于 consolidationInputBytes',
      },
    )
    .refine(
      (values) => (
        values['memory.budgets.gitDiffBytes']
        <= values['memory.budgets.consolidationInputBytes']
      ),
      {
        message: 'gitDiffBytes 不能大于 consolidationInputBytes(diff 是整合输入的一部分)',
      },
    ),
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
