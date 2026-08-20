// Memory 包全部可调参数,用 @ema-agent/settings 的 defineSetting 声明:
// schema 驱动校验 + 类型推导 + 注册进设置目录(UI 可查、可配、测试可覆盖)。
// 消费模式与 git 包一致:消费方持有 SettingsStore,在一次操作开始时调用
// readMemorySettings(store),再把明确设置传给业务函数。默认值取 DEFAULT_MEMORY_SETTINGS
// (单一事实源 = 各 setting 的 defaultValue)。
//
// 分组与制约(对齐 settings 包 SettingGroup 语义——只有跨字段约束才建组):
//   - `memory.limits` 组:内部容量上限 + 用户总预算放在一起 refine,因为
//     单文件上限 ≤ 总预算(否则"永不静默删 MEMORY.md"规则下超限无法靠删除解决)、
//     turnEvidenceBytes ≤ integrationRenderedBytes(单条证据需能装进整合渲染)。
//   - workspace / guard 各单 key 无跨字段约束,不建组(settings 包文档明确)。
//   - `memory.storage.maxBytes` 的 key 归 storage 域,但参与 limits 组的整组 refine
//     (组 id 与 key 前缀解耦,settings 包允许)。

import { defineSetting, type SettingsStore, type SettingGroup } from '@ema-agent/settings';
import { z } from 'zod';

// ── 声明:用户可见总预算 ─────────────────────────────────────────────────────

export const memoryStorageMaxBytesSetting = defineSetting<number>({
  key: 'memory.storage.maxBytes',
  apply: 'nextOperation',
  defaultValue: 256 * 1024 * 1024, // 256 MiB
  schema: z.number().int().min(16 * 1024 * 1024).max(4 * 1024 * 1024 * 1024),
  group: 'memory.limits',
});

// ── 声明:内部容量上限组 memory.limits(设计定稿第 5 节) ──────────────────────

export const memorySummaryTokensSetting = defineSetting<number>({
  key: 'memory.limits.summaryTokens',
  apply: 'nextOperation',
  defaultValue: 2_500,
  schema: z.number().int().min(100).max(20_000),
  group: 'memory.limits',
});

export const memoryDocBytesSetting = defineSetting<number>({
  key: 'memory.limits.memoryDocBytes',
  apply: 'nextOperation',
  defaultValue: 128 * 1024, // 128 KiB
  schema: z.number().int().min(16 * 1024).max(8 * 1024 * 1024),
  group: 'memory.limits',
});

export const memoryTopicsBytesSetting = defineSetting<number>({
  key: 'memory.limits.topicsBytes',
  apply: 'nextOperation',
  defaultValue: 256 * 1024, // 256 KiB
  schema: z.number().int().min(16 * 1024).max(16 * 1024 * 1024),
  group: 'memory.limits',
});

export const memoryHistoryBytesSetting = defineSetting<number>({
  key: 'memory.limits.historyBytes',
  apply: 'nextOperation',
  defaultValue: 256 * 1024, // 256 KiB
  schema: z.number().int().min(16 * 1024).max(16 * 1024 * 1024),
  group: 'memory.limits',
});

export const memoryTurnEvidenceBytesSetting = defineSetting<number>({
  key: 'memory.limits.turnEvidenceBytes',
  apply: 'nextOperation',
  defaultValue: 64 * 1024, // 64 KiB
  schema: z.number().int().min(4 * 1024).max(4 * 1024 * 1024),
  group: 'memory.limits',
});

export const memoryIntegrationItemsSetting = defineSetting<number>({
  key: 'memory.limits.integrationItems',
  apply: 'nextOperation',
  defaultValue: 256,
  schema: z.number().int().min(1).max(4_096),
  group: 'memory.limits',
});

export const memoryIntegrationRenderedBytesSetting = defineSetting<number>({
  key: 'memory.limits.integrationRenderedBytes',
  apply: 'nextOperation',
  defaultValue: 2 * 1024 * 1024, // 2 MiB
  schema: z.number().int().min(256 * 1024).max(64 * 1024 * 1024),
  group: 'memory.limits',
});

// ── 组:memory.limits(跨字段约束) ────────────────────────────────────────────

const limitsGroupValues = z
  .object({
    'memory.storage.maxBytes': z.number(),
    'memory.limits.summaryTokens': z.number(),
    'memory.limits.memoryDocBytes': z.number(),
    'memory.limits.topicsBytes': z.number(),
    'memory.limits.historyBytes': z.number(),
    'memory.limits.turnEvidenceBytes': z.number(),
    'memory.limits.integrationItems': z.number(),
    'memory.limits.integrationRenderedBytes': z.number(),
  })
  .refine(
    (g) => {
      const singleFileMax = Math.max(
        g['memory.limits.memoryDocBytes'],
        g['memory.limits.topicsBytes'],
        g['memory.limits.historyBytes'],
        g['memory.limits.turnEvidenceBytes'],
      );
      return singleFileMax <= g['memory.storage.maxBytes'];
    },
    {
      message:
        '单文件上限(memoryDocBytes/topicsBytes/historyBytes/turnEvidenceBytes)不能超过总预算 memory.storage.maxBytes',
    },
  )
  .refine(
    (g) => g['memory.limits.turnEvidenceBytes'] <= g['memory.limits.integrationRenderedBytes'],
    {
      message:
        'memory.limits.turnEvidenceBytes 不能大于 memory.limits.integrationRenderedBytes(单条证据需能装进整合渲染)',
    },
  );

export const memoryLimitsGroup: SettingGroup = {
  id: 'memory.limits',
  definitions: [
    memoryStorageMaxBytesSetting,
    memorySummaryTokensSetting,
    memoryDocBytesSetting,
    memoryTopicsBytesSetting,
    memoryHistoryBytesSetting,
    memoryTurnEvidenceBytesSetting,
    memoryIntegrationItemsSetting,
    memoryIntegrationRenderedBytesSetting,
  ],
  schema: limitsGroupValues,
};

// ── 声明:workspace(单 key,无跨字段约束,不建组) ──────────────────────────────

export const memoryWorkspaceDiffFileMaxBytesSetting = defineSetting<number>({
  key: 'memory.workspace.diffFileMaxBytes',
  apply: 'nextOperation',
  defaultValue: 4 * 1024 * 1024, // 4 MiB
  schema: z.number().int().min(64 * 1024).max(64 * 1024 * 1024),
});

// ── 声明:guard(单 key) ───────────────────────────────────────────────────────

export const memoryGuardScanEntryLimitSetting = defineSetting<number>({
  key: 'memory.guard.scanEntryLimit',
  apply: 'nextOperation',
  defaultValue: 200_000,
  schema: z.number().int().min(1_000).max(2_000_000),
});

// ── 类型与默认值 ────────────────────────────────────────────────────────────

export interface MemorySettings {
  /** 记忆根总预算(用户可见;超限处置顺序见 common/capacity PRESSURE_ACTIONS)。 */
  storageMaxBytes: number;
  /** memory_summary.md 每轮注入 token 上限(与 codex 2500 一致)。 */
  summaryTokens: number;
  /** MEMORY.md / 角色 MEMORY.md 上限。 */
  memoryDocBytes: number;
  /** topics/*.md 上限。 */
  topicsBytes: number;
  /** history/*.md 上限。 */
  historyBytes: number;
  /** turn_evidence/*.md 上限。 */
  turnEvidenceBytes: number;
  /** 单次整合最多条数。 */
  integrationItems: number;
  /** 单次整合渲染后上限。 */
  integrationRenderedBytes: number;
  /** phase2_workspace_diff.md 单文件上限(字符边界截断)。 */
  diffFileMaxBytes: number;
  /** 预算统计扫描条目软上限。 */
  scanEntryLimit: number;
}

/** Memory 操作使用的默认设置，单一事实源是各 setting 的 defaultValue。 */
export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  storageMaxBytes: memoryStorageMaxBytesSetting.defaultValue,
  summaryTokens: memorySummaryTokensSetting.defaultValue,
  memoryDocBytes: memoryDocBytesSetting.defaultValue,
  topicsBytes: memoryTopicsBytesSetting.defaultValue,
  historyBytes: memoryHistoryBytesSetting.defaultValue,
  turnEvidenceBytes: memoryTurnEvidenceBytesSetting.defaultValue,
  integrationItems: memoryIntegrationItemsSetting.defaultValue,
  integrationRenderedBytes: memoryIntegrationRenderedBytesSetting.defaultValue,
  diffFileMaxBytes: memoryWorkspaceDiffFileMaxBytesSetting.defaultValue,
  scanEntryLimit: memoryGuardScanEntryLimitSetting.defaultValue,
};

/** 一次性读取当前 Memory 设置，坏值或缺失值由 SettingsStore 回落到默认值。 */
export function readMemorySettings(store: SettingsStore): MemorySettings {
  return {
    storageMaxBytes: store.get(memoryStorageMaxBytesSetting),
    summaryTokens: store.get(memorySummaryTokensSetting),
    memoryDocBytes: store.get(memoryDocBytesSetting),
    topicsBytes: store.get(memoryTopicsBytesSetting),
    historyBytes: store.get(memoryHistoryBytesSetting),
    turnEvidenceBytes: store.get(memoryTurnEvidenceBytesSetting),
    integrationItems: store.get(memoryIntegrationItemsSetting),
    integrationRenderedBytes: store.get(memoryIntegrationRenderedBytesSetting),
    diffFileMaxBytes: store.get(memoryWorkspaceDiffFileMaxBytesSetting),
    scanEntryLimit: store.get(memoryGuardScanEntryLimitSetting),
  };
}
