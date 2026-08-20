// 聚合 Memory 每次读取、生成与整合操作使用的业务预算.

import type { SettingsStore } from '@ema-agent/settings';
import {
  memoryConsolidationInputBytesSetting,
  memoryConsolidationItemsSetting,
  memoryCoreFileBytesSetting,
  memoryGitDiffBytesSetting,
  memoryHistoryFileBytesSetting,
  memorySummaryTokensSetting,
  memoryTopicFileBytesSetting,
  memoryTurnEvidenceFileBytesSetting,
  memoryTurnEvidenceFilesSetting,
} from '../settings.js';

export interface MemoryBudgets {
  readonly summaryTokens: number;
  readonly coreMemoryFileBytes: number;
  readonly topicFileBytes: number;
  readonly historyFileBytes: number;
  readonly turnEvidenceFileBytes: number;
  readonly turnEvidenceFiles: number;
  readonly consolidationItems: number;
  readonly consolidationInputBytes: number;
  readonly gitDiffBytes: number;
}

export const DEFAULT_MEMORY_BUDGETS: MemoryBudgets = {
  summaryTokens: memorySummaryTokensSetting.defaultValue,
  coreMemoryFileBytes: memoryCoreFileBytesSetting.defaultValue,
  topicFileBytes: memoryTopicFileBytesSetting.defaultValue,
  historyFileBytes: memoryHistoryFileBytesSetting.defaultValue,
  turnEvidenceFileBytes: memoryTurnEvidenceFileBytesSetting.defaultValue,
  turnEvidenceFiles: memoryTurnEvidenceFilesSetting.defaultValue,
  consolidationItems: memoryConsolidationItemsSetting.defaultValue,
  consolidationInputBytes: memoryConsolidationInputBytesSetting.defaultValue,
  gitDiffBytes: memoryGitDiffBytesSetting.defaultValue,
};

export function readMemoryBudgets(store: SettingsStore): MemoryBudgets {
  return {
    summaryTokens: store.get(memorySummaryTokensSetting),
    coreMemoryFileBytes: store.get(memoryCoreFileBytesSetting),
    topicFileBytes: store.get(memoryTopicFileBytesSetting),
    historyFileBytes: store.get(memoryHistoryFileBytesSetting),
    turnEvidenceFileBytes: store.get(memoryTurnEvidenceFileBytesSetting),
    turnEvidenceFiles: store.get(memoryTurnEvidenceFilesSetting),
    consolidationItems: store.get(memoryConsolidationItemsSetting),
    consolidationInputBytes: store.get(memoryConsolidationInputBytesSetting),
    gitDiffBytes: store.get(memoryGitDiffBytesSetting),
  };
}
