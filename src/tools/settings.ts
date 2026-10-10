// 内置工具的用户级启用/禁用设置。
// 禁用设置与能力装配(validateContext)、Plan 只读筛选分别生效.
// 工具必须同时满足这些条件才提供给模型. 默认空数组 = 不主动禁用工具.

import type { SettingsStore } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';
import { BuiltinTools } from './Tool/BuiltinToolIdentity.js';

/** 提问通道的稳定 id: 永远不可禁用(禁用会切断人与模型的确认通道)。
 *  身份来自框架层单一事实源 BuiltinToolIdentity, 不与工具实现包重复。 */
export const ASK_USER_TOOL_ID = BuiltinTools.AskUser.id;

/** 内置工具禁用: 存工具的稳定 id(BuiltinTools.*.id), Chat 与 Work 共用这份设置. */
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
