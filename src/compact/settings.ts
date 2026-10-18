import type { SettingsStore, SettingGroup } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

export interface CompactSettings {
  /** 输入估算超过 contextWindow * (1 - bufferRatio) 时尝试压缩. */
  readonly bufferRatio: number;
  /** Micro 保留最近多少条可压缩的成功工具结果. */
  readonly keepRecentToolResults: number;
  /** 同一压缩函数中, Session 连续失败达到此次数后暂停自动压缩. */
  readonly maximumConsecutiveFailures: number;
  /** 近期原文目标为 contextWindow * retainRatio; 放不下摘要时会继续扩大摘要范围. */
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
    'context.compact.keepRecentToolResults': z.number(),
    'context.compact.maximumConsecutiveFailures': z.number(),
    'context.compact.retainRatio': z.number(),
    'context.compact.manualMinRatio': z.number(),
  }),
};

export const DEFAULT_COMPACT_SETTINGS: CompactSettings = {
  bufferRatio: compactBufferRatioSetting.defaultValue,
  keepRecentToolResults: compactKeepRecentToolResultsSetting.defaultValue,
  maximumConsecutiveFailures: compactMaximumConsecutiveFailuresSetting.defaultValue,
  retainRatio: compactRetainRatioSetting.defaultValue,
};

export function readCompactSettings(store: SettingsStore): CompactSettings {
  return {
    bufferRatio: store.get(compactBufferRatioSetting),
    keepRecentToolResults: store.get(compactKeepRecentToolResultsSetting),
    maximumConsecutiveFailures: store.get(compactMaximumConsecutiveFailuresSetting),
    retainRatio: store.get(compactRetainRatioSetting),
  };
}
