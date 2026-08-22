// 定义下一根 Turn 使用的自动压缩预算与失败熔断设置。
// 设置接口与字段统一在此文件:类型、默认、定义、组、聚合读取全部在 settings.ts,
// types.ts 只保留业务请求/结果类型(CompactRequest 等)。
// 拆细为一字段一 key;defaultReserved ≤ maximumReserved 是跨字段约束,
// 故声明 group 'context.compact' 由 SettingsStore 整组 refine。

import type { SettingsStore, SettingGroup } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

/** 根 Turn 冻结的自动压缩预算、保留窗口与失败熔断设置。 */
export interface CompactSettings {
  readonly enabled: boolean;
  readonly bufferTokens: number;
  readonly defaultReservedOutputTokens: number;
  readonly maximumReservedOutputTokens: number;
  readonly keepRecentToolResults: number;
  readonly maximumConsecutiveFailures: number;
}

export const COMPACT_GROUP = 'context.compact';

export const compactEnabledSetting = defineSetting<boolean>({
  key: 'context.compact.enabled',
  label: '自动压缩',
  description: '自动压缩开关：达到预算时自动压缩上下文。',
  apply: 'nextTurn',
  defaultValue: true,
  schema: z.boolean(),
  group: COMPACT_GROUP,
});

export const compactBufferTokensSetting = defineSetting<number>({
  key: 'context.compact.bufferTokens',
  label: '压缩缓冲 token',
  description: '压缩前预留的缓冲 token，避免临界值频繁触发压缩。',
  apply: 'nextTurn',
  defaultValue: 13_000,
  schema: z.number().int().min(1_000).max(64_000),
  group: COMPACT_GROUP,
});

export const compactDefaultReservedOutputTokensSetting = defineSetting<number>({
  key: 'context.compact.defaultReservedOutputTokens',
  label: '默认输出保留预算',
  description: '压缩后默认保留的输出 token 预算（不能大于最大保留）。',
  apply: 'nextTurn',
  defaultValue: 8_000,
  schema: z.number().int().min(1_000).max(64_000),
  group: COMPACT_GROUP,
});

export const compactMaximumReservedOutputTokensSetting = defineSetting<number>({
  key: 'context.compact.maximumReservedOutputTokens',
  label: '最大输出保留预算',
  description: '压缩后最多保留的输出 token 预算。',
  apply: 'nextTurn',
  defaultValue: 20_000,
  schema: z.number().int().min(1_000).max(128_000),
  group: COMPACT_GROUP,
});

export const compactKeepRecentToolResultsSetting = defineSetting<number>({
  key: 'context.compact.keepRecentToolResults',
  label: '保留最近工具结果数',
  description: '压缩时保留的最近工具结果条数。',
  apply: 'nextTurn',
  defaultValue: 6,
  schema: z.number().int().min(1).max(32),
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

/** context.compact 组内全部字段定义(供 SettingsStore 注册组)。 */
export const COMPACT_SETTINGS = [
  compactEnabledSetting,
  compactBufferTokensSetting,
  compactDefaultReservedOutputTokensSetting,
  compactMaximumReservedOutputTokensSetting,
  compactKeepRecentToolResultsSetting,
  compactMaximumConsecutiveFailuresSetting,
] as const;

/**
 * context.compact 设置组:跨字段约束 defaultReservedOutputTokens ≤ maximumReservedOutputTokens。
 */
export const compactGroup: SettingGroup = {
  id: COMPACT_GROUP,
  definitions: COMPACT_SETTINGS,
  schema: z
    .object({
      'context.compact.enabled': z.boolean(),
      'context.compact.bufferTokens': z.number(),
      'context.compact.defaultReservedOutputTokens': z.number(),
      'context.compact.maximumReservedOutputTokens': z.number(),
      'context.compact.keepRecentToolResults': z.number(),
      'context.compact.maximumConsecutiveFailures': z.number(),
    })
    .refine(
      g =>
        g['context.compact.defaultReservedOutputTokens'] <=
        g['context.compact.maximumReservedOutputTokens'],
      { message: 'defaultReservedOutputTokens 不能大于 maximumReservedOutputTokens' },
    ),
};

/** 整组默认快照(供消费方默认参数与测试),单一事实源是各 setting 的 defaultValue。 */
export const DEFAULT_COMPACT_SETTINGS: CompactSettings = {
  enabled: compactEnabledSetting.defaultValue,
  bufferTokens: compactBufferTokensSetting.defaultValue,
  defaultReservedOutputTokens: compactDefaultReservedOutputTokensSetting.defaultValue,
  maximumReservedOutputTokens: compactMaximumReservedOutputTokensSetting.defaultValue,
  keepRecentToolResults: compactKeepRecentToolResultsSetting.defaultValue,
  maximumConsecutiveFailures: compactMaximumConsecutiveFailuresSetting.defaultValue,
};

/** 聚合读取整块压缩预算快照(坏值/缺失自动回落默认)。 */
export function readCompactSettings(store: SettingsStore): CompactSettings {
  return {
    enabled: store.get(compactEnabledSetting),
    bufferTokens: store.get(compactBufferTokensSetting),
    defaultReservedOutputTokens: store.get(compactDefaultReservedOutputTokensSetting),
    maximumReservedOutputTokens: store.get(compactMaximumReservedOutputTokensSetting),
    keepRecentToolResults: store.get(compactKeepRecentToolResultsSetting),
    maximumConsecutiveFailures: store.get(compactMaximumConsecutiveFailuresSetting),
  };
}
