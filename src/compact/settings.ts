// 定义下一根 Turn 使用的自动压缩预算与失败熔断设置。
// 设置接口与字段统一在此文件:类型、默认、定义、组、聚合读取全部在 settings.ts,
// types.ts 只保留业务请求/结果类型(CompactRequest 等)。
// 拆细为一字段一 key;触发线按窗口比例表达(比例制),不随窗口大小漂移。

import type { SettingsStore, SettingGroup } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

/** 根 Turn 冻结的自动压缩预算、保留窗口与失败熔断设置。 */
export interface CompactSettings {
  /** 触发线余量比例：估算达到窗口的 (1 - bufferRatio) 即压缩；默认 0.15 即 85%。 */
  readonly bufferRatio: number;
  /** Macro 摘要调用的输出 token 预算；实际发送按剩余空间裁剪。 */
  readonly outputTokens: number;
  readonly keepRecentToolResults: number;
  readonly maximumConsecutiveFailures: number;
  /** 近期原文保留比例（相对 contextWindow）；硬预算不足时 Compact 会继续扩大摘要范围。 */
  readonly retainRatio: number;
}

// manualMinRatio 是手动命令的准入策略（commands 在入口经 compactManualMinRatioSetting
// 直读），不属于随每次请求传递的压缩算法设置，故不在本快照内。

export const COMPACT_GROUP = 'context.compact';

export const compactBufferRatioSetting = defineSetting<number>({
  key: 'context.compact.bufferRatio',
  label: '压缩触发缓冲比例',
  description: '上下文估算达到窗口的 (1 - 比例) 时强制压缩；默认 0.15 即达到 85% 时压缩。',
  apply: 'nextTurn',
  defaultValue: 0.15,
  schema: z.number().min(0.05).max(0.2),
  group: COMPACT_GROUP,
});

export const compactOutputTokensSetting = defineSetting<number>({
  key: 'context.compact.outputTokens',
  label: '压缩输出 token 预算',
  description: '摘要模型一次压缩允许的最大输出 token；实际发送按剩余空间裁剪。',
  apply: 'nextTurn',
  defaultValue: 8_000,
  schema: z.number().int().min(1_000).max(64_000),
  group: COMPACT_GROUP,
});

export const compactKeepRecentToolResultsSetting = defineSetting<number>({
  key: 'context.compact.keepRecentToolResults',
  label: '保留最近工具结果数',
  description: '压缩时保留的最近工具结果条数。',
  apply: 'nextTurn',
  defaultValue: 6,
  schema: z.number().int().min(1).max(10),
  group: COMPACT_GROUP,
});

export const compactMaximumConsecutiveFailuresSetting = defineSetting<number>({
  key: 'context.compact.maximumConsecutiveFailures',
  label: '连续失败熔断次数',
  description: '连续压缩失败的最大次数；超过后熔断暂停自动压缩。',
  apply: 'nextTurn',
  defaultValue: 3,
  schema: z.number().int().min(1).max(10),
  group: COMPACT_GROUP,
});

export const compactRetainRatioSetting = defineSetting<number>({
  key: 'context.compact.retainRatio',
  label: '近期原文保留比例',
  description: '压缩时按上下文窗口比例保留近期原文尾部Token数；硬预算放不下时会继续扩大摘要范围。',
  apply: 'nextTurn',
  defaultValue: 0.16,
  schema: z.number().min(0.05).max(0.25),
  group: COMPACT_GROUP,
});

export const compactManualMinRatioSetting = defineSetting<number>({
  key: 'context.compact.manualMinRatio',
  label: '手动压缩下限比例',
  description: '历史估算低于上下文窗口的该比例时，手动 /compact 没有意义，明确拒绝。',
  apply: 'nextOperation',
  defaultValue: 0.15,
  schema: z.number().min(0.05).max(0.5),
  group: COMPACT_GROUP,
});

/** context.compact 组内全部字段定义(供 SettingsStore 注册组)。 */
export const COMPACT_SETTINGS = [
  compactBufferRatioSetting,
  compactOutputTokensSetting,
  compactKeepRecentToolResultsSetting,
  compactMaximumConsecutiveFailuresSetting,
  compactRetainRatioSetting,
  compactManualMinRatioSetting,
] as const;

/** context.compact 设置组。 */
export const compactGroup: SettingGroup = {
  id: COMPACT_GROUP,
  definitions: COMPACT_SETTINGS,
  schema: z.object({
    'context.compact.enabled': z.boolean(),
    'context.compact.bufferRatio': z.number(),
    'context.compact.outputTokens': z.number(),
    'context.compact.keepRecentToolResults': z.number(),
    'context.compact.maximumConsecutiveFailures': z.number(),
    'context.compact.retainRatio': z.number(),
    'context.compact.manualMinRatio': z.number(),
  }),
};

/** 整组默认快照(供消费方默认参数与测试),单一事实源是各 setting 的 defaultValue。 */
export const DEFAULT_COMPACT_SETTINGS: CompactSettings = {
  bufferRatio: compactBufferRatioSetting.defaultValue,
  outputTokens: compactOutputTokensSetting.defaultValue,
  keepRecentToolResults: compactKeepRecentToolResultsSetting.defaultValue,
  maximumConsecutiveFailures: compactMaximumConsecutiveFailuresSetting.defaultValue,
  retainRatio: compactRetainRatioSetting.defaultValue,
};

/** 聚合读取整块压缩预算快照(坏值/缺失自动回落默认)。 */
export function readCompactSettings(store: SettingsStore): CompactSettings {
  return {
    bufferRatio: store.get(compactBufferRatioSetting),
    outputTokens: store.get(compactOutputTokensSetting),
    keepRecentToolResults: store.get(compactKeepRecentToolResultsSetting),
    maximumConsecutiveFailures: store.get(compactMaximumConsecutiveFailuresSetting),
    retainRatio: store.get(compactRetainRatioSetting),
  };
}
