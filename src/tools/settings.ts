// 内置工具的用户级启用/禁用设置。
// 禁用是"黑名单"维度, 与能力装配(validateContext)和产品执行模式(chat/work
// 白名单)正交——三者叠加后才是模型可见集合。默认空数组 = 全部启用。

import type { SettingsStore } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';
import { BuiltinTools } from './Tool/BuiltinToolIdentity.js';

/** 提问通道的稳定 id: 永远不可禁用(禁用会切断人与模型的确认通道)。
 *  身份来自框架层单一事实源 BuiltinToolIdentity, 不与工具实现包重复。 */
export const ASK_USER_TOOL_ID = BuiltinTools.AskUser.id;

/** 内置工具禁用: 存工具的稳定 id(BuiltinTools.*.id), 默认全开。
 *  与执行模式白名单(chat/work)是独立维度: 这里禁掉的工具两种模式都不可见。 */
export const disabledToolsSetting = defineSetting({
  key: 'tools.disabled',
  apply: 'nextTurn',
  defaultValue: [],
  schema: z
    .array(z.string())
    .refine((ids) => !ids.includes(ASK_USER_TOOL_ID), {
      message: 'AskUser 是提问通道, 不能被禁用',
    }),
});

/** 本 Turn 冻结的工具设置快照。 */
export interface ToolSettings {
  /** 被禁用的内置工具稳定 id; 空数组 = 全部启用。 */
  readonly disabledToolIds: readonly string[];
}

/** 整组默认快照(供装配方默认参数与测试), 单一事实源是各 setting 的 defaultValue。 */
export const DEFAULT_TOOL_SETTINGS: ToolSettings = {
  disabledToolIds: disabledToolsSetting.defaultValue,
};

/** 聚合读取整块快照: 坏值/缺失自动回落默认。 */
export function readToolSettings(store: SettingsStore): ToolSettings {
  return {
    disabledToolIds: store.get(disabledToolsSetting),
  };
}
