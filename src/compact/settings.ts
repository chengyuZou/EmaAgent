import type { SettingsStore, SettingGroup } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

/**
 * @param bufferRatio 估算达到窗口的 (1 - bufferRatio) % 即压缩;
 * @param outputTokens 调用 API 压缩的最大输出 token
 * @param keepRecentToolResults 压缩时保留最近的 ToolResult 条数
 * @param maximumConsecutiveFailures 连续失败次数上限, 超过则不再尝试调用 API 生成摘要
 * @param retainRatio 近期原文保留比例 保留约 (retainRatio * contextWindow) Token硬预算不足时 Compact 会继续扩大摘要范围
 */
export interface CompactSettings {
  readonly bufferRatio: number;
  readonly outputTokens: number;
  readonly keepRecentToolResults: number;
  readonly maximumConsecutiveFailures: number;
  readonly retainRatio: number;
}

export const COMPACT_GROUP = 'context.compact';

export const compactBufferRatioSetting = defineSetting({
  key: 'context.compact.bufferRatio',
  apply: 'nextTurn',
  defaultValue: 0.15,
  schema: z.number().min(0.05).max(0.2),
  group: COMPACT_GROUP,
});

export const compactOutputTokensSetting = defineSetting({
  key: 'context.compact.outputTokens',
  apply: 'nextTurn',
  defaultValue: 8_000,
  schema: z.number().int().min(1_000).max(64_000),
  group: COMPACT_GROUP,
});

export const compactKeepRecentToolResultsSetting = defineSetting({
  key: 'context.compact.keepRecentToolResults',
  apply: 'nextTurn',
  defaultValue: 6,
  schema: z.number().int().min(1).max(10),
  group: COMPACT_GROUP,
});

export const compactMaximumConsecutiveFailuresSetting = defineSetting({
  key: 'context.compact.maximumConsecutiveFailures',
  apply: 'nextTurn',
  defaultValue: 3,
  schema: z.number().int().min(1).max(5),
  group: COMPACT_GROUP,
});

export const compactRetainRatioSetting = defineSetting({
  key: 'context.compact.retainRatio',
  apply: 'nextTurn',
  defaultValue: 0.16,
  schema: z.number().min(0.05).max(0.25),
  group: COMPACT_GROUP,
});

export const compactManualMinRatioSetting = defineSetting({
  key: 'context.compact.manualMinRatio',
  apply: 'nextOperation',
  defaultValue: 0.15,
  schema: z.number().min(0.05).max(0.5),
  group: COMPACT_GROUP,
});

export const COMPACT_SETTINGS = [
  compactBufferRatioSetting,
  compactOutputTokensSetting,
  compactKeepRecentToolResultsSetting,
  compactMaximumConsecutiveFailuresSetting,
  compactRetainRatioSetting,
  compactManualMinRatioSetting,
] as const;

export const compactGroup: SettingGroup = {
  id: COMPACT_GROUP,
  definitions: COMPACT_SETTINGS,
  schema: z.object({
    'context.compact.bufferRatio': z.number(),
    'context.compact.outputTokens': z.number(),
    'context.compact.keepRecentToolResults': z.number(),
    'context.compact.maximumConsecutiveFailures': z.number(),
    'context.compact.retainRatio': z.number(),
    'context.compact.manualMinRatio': z.number(),
  }),
};

export const DEFAULT_COMPACT_SETTINGS: CompactSettings = {
  bufferRatio: compactBufferRatioSetting.defaultValue,
  outputTokens: compactOutputTokensSetting.defaultValue,
  keepRecentToolResults: compactKeepRecentToolResultsSetting.defaultValue,
  maximumConsecutiveFailures: compactMaximumConsecutiveFailuresSetting.defaultValue,
  retainRatio: compactRetainRatioSetting.defaultValue,
};

export function readCompactSettings(store: SettingsStore): CompactSettings {
  return {
    bufferRatio: store.get(compactBufferRatioSetting),
    outputTokens: store.get(compactOutputTokensSetting),
    keepRecentToolResults: store.get(compactKeepRecentToolResultsSetting),
    maximumConsecutiveFailures: store.get(compactMaximumConsecutiveFailuresSetting),
    retainRatio: store.get(compactRetainRatioSetting),
  };
}
