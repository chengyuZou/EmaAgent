// 定义 Memory 物理存储上限与单次业务预算.

import type { SettingGroup } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

export const memoryStorageMaxBytesSetting = defineSetting<number>({
  key: 'memory.storage.maxBytes',
  apply: 'nextOperation',
  defaultValue: 256 * 1024 * 1024,
  schema: z.number().int().min(16 * 1024 * 1024).max(4 * 1024 * 1024 * 1024),
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

export const MEMORY_SETTINGS = [
  memoryStorageMaxBytesSetting,
  memorySummaryTokensSetting,
  memoryCoreFileBytesSetting,
  memoryTopicFileBytesSetting,
  memoryHistoryFileBytesSetting,
  memoryTurnEvidenceFileBytesSetting,
  memoryTurnEvidenceFilesSetting,
  memoryConsolidationItemsSetting,
  memoryConsolidationInputBytesSetting,
  memoryGitDiffBytesSetting,
] as const;

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
    ),
};
