// 定义 Memory 物理存储上限与单次业务预算.

import type { SettingGroup, SettingsStore } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

export const memoryStorageMaxBytesSetting = defineSetting<number>({
  key: 'memory.storage.maxBytes',
  label: '记忆存储体积上限',
  description: 'Memory 物理存储硬上限（字节）。超过后触发自动清理，仍无法降回警告线则报错交用户处理。',
  apply: 'nextOperation',
  defaultValue: 1024 * 1024 * 1024,
  schema: z.number().int().min(500 * 1024 * 1024).max(5 * 1024 * 1024 * 1024),
});

export const memoryWorkHistoryRetentionDaysSetting = defineSetting<number>({
  key: 'memory.work.historyRetentionDays',
  label: '工作历史保留天数',
  description: 'Work 轨历史文件按最后修改时间保留的墙钟天数；超过该天数的 history 文件成为自动清理候选。',
  apply: 'nextOperation',
  defaultValue: 90,
  schema: z.number().int().min(30).max(3_650),
  group: 'memory.lifecycle',
});

export const memoryRelationshipHistoryActiveDaysSetting = defineSetting<number>({
  key: 'memory.relationship.historyActiveDays',
  label: '关系历史活跃天数',
  description: '每个角色保留的历史活跃日数量；只保留最近 N 个有历史记录的日期，用户离线不推进衰减。',
  apply: 'nextOperation',
  defaultValue: 180,
  schema: z.number().int().min(30).max(3_650),
  group: 'memory.lifecycle',
});

export const memorySummaryTokensSetting = defineSetting<number>({
  key: 'memory.budgets.summaryTokens',
  label: '摘要注入 token 预算',
  description: '每轨记忆摘要注入 system prompt 的 token 预算；摘要按此上限截断。',
  apply: 'nextTurn',
  defaultValue: 2_500,
  schema: z.number().int().min(1000).max(20_000),
  group: 'memory.budgets',
});

export const memoryCoreFileBytesSetting = defineSetting<number>({
  key: 'memory.budgets.coreMemoryFileBytes',
  label: '核心记忆文件体积上限',
  description: '核心正式记忆文件（如 MEMORY.md）的字节上限预算。',
  apply: 'nextOperation',
  defaultValue: 128 * 1024,
  schema: z.number().int().min(16 * 1024).max(8 * 1024 * 1024),
  group: 'memory.budgets',
});

export const memoryTopicFileBytesSetting = defineSetting<number>({
  key: 'memory.budgets.topicFileBytes',
  label: '主题文件体积上限',
  description: 'Work 轨主题文件（topics/*.md）的字节上限预算。',
  apply: 'nextOperation',
  defaultValue: 16 * 1024 * 1024,
  schema: z.number().int().min(1024 * 1024).max(64 * 1024 * 1024),
  group: 'memory.budgets',
});

export const memoryHistoryFileBytesSetting = defineSetting<number>({
  key: 'memory.budgets.historyFileBytes',
  label: '历史文件体积上限',
  description: '历史/演进文件（history/*.md）的字节上限预算。',
  apply: 'nextOperation',
  defaultValue: 16 * 1024 * 1024,
  schema: z.number().int().min(1024 * 1024).max(64 * 1024 * 1024),
  group: 'memory.budgets',
});

export const memoryTurnEvidenceFileBytesSetting = defineSetting<number>({
  key: 'memory.budgets.turnEvidenceFileBytes',
  label: '单条证据文件体积上限',
  description: '单个 Turn 证据文件（turn_evidence/*.md）的字节上限预算。',
  apply: 'nextOperation',
  defaultValue: 16 * 1024 * 1024,
  schema: z.number().int().min(1024 * 1024).max(64 * 1024 * 1024),
  group: 'memory.budgets',
});

export const memoryTurnEvidenceFilesSetting = defineSetting<number>({
  key: 'memory.budgets.turnEvidenceFiles',
  label: '证据文件保留数量',
  description: '保留的 Turn 证据文件数量上限；只保留最新 N 个。',
  apply: 'nextOperation',
  defaultValue: 200,
  schema: z.number().int().min(100).max(2_000),
  group: 'memory.budgets',
});

export const memoryConsolidationItemsSetting = defineSetting<number>({
  key: 'memory.budgets.consolidationItems',
  label: '单次整合条数上限',
  description: '单次整合消费的未整合提取结果条数上限。',
  apply: 'nextOperation',
  defaultValue: 256,
  schema: z.number().int().min(100).max(1024),
  group: 'memory.budgets',
});

export const memoryConsolidationInputBytesSetting = defineSetting<number>({
  key: 'memory.budgets.consolidationInputBytes',
  label: '单次整合输入体积预算',
  description: '单次整合 LLM 输入的字节预算；超限部分截断并标注。',
  apply: 'nextOperation',
  defaultValue: 16 * 1024 * 1024,
  schema: z.number().int().min(1024 * 1024).max(64 * 1024 * 1024),
  group: 'memory.budgets',
});

export const memoryGitDiffBytesSetting = defineSetting<number>({
  key: 'memory.budgets.gitDiffBytes',
  label: '工作区 diff 体积预算',
  description: '整合前工作区 diff 渲染的字节预算。',
  apply: 'nextOperation',
  defaultValue: 16 * 1024 * 1024,
  schema: z.number().int().min(1024 * 1024).max(64 * 1024 * 1024),
  group: 'memory.budgets',
});

// ── 运行参数 memory.jobs(提取并发 / 整合心跳) ─────────────────────────────────
// 各自有 zod 范围(单字段限制);真正的跨字段联合限制在 memory.budgets 组
// (gitDiff/turnEvidence 都 ≤ consolidationInputBytes)。

export const memoryExtractionConcurrencySetting = defineSetting<number>({
  key: 'memory.jobs.extractionConcurrency',
  label: '提取任务并发上限',
  description: '提取 Job 的后台并发上限。',
  apply: 'nextOperation',
  defaultValue: 4,
  schema: z.number().int().min(1).max(32),
  group: 'memory.jobs',
});

export const memoryHeartbeatSecondsSetting = defineSetting<number>({
  key: 'memory.jobs.heartbeatSeconds',
  label: '任务心跳间隔（秒）',
  description: '整合/维护 Job 的心跳间隔秒；失去所有权即中止。',
  apply: 'nextOperation',
  defaultValue: 30,
  schema: z.number().int().min(30).max(600),
  group: 'memory.jobs',
});

export const memoryConsolidationCooldownHoursSetting = defineSetting<number>({
  key: 'memory.jobs.consolidationCooldownHours',
  label: '整合冷却小时数',
  description: '整合冷却小时数（0 = 关闭）。冷却期内该轨整合 Job 不被认领，避免每个 Turn 都调整合 LLM。',
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
