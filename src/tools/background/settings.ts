// 定义后台 Shell 后续新进程采用的并发数和最长运行时间。
// 设置接口与字段统一在此文件;拆细为一字段一 key;
// runtime 仍要整块快照,由 readBackgroundProcessSettings 聚合。

import type { SettingsStore } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

/** 后台 Shell 后续新进程采用的并发数与最长运行时间。 */
export interface BackgroundProcessSettings {
  maxConcurrent: number;
  maxRuntimeHours: number;
}

export const maxConcurrentBackgroundSetting = defineSetting<number>({
  key: 'tools.backgroundProcess.maxConcurrent',
  label: '后台进程并发上限',
  description: '后台 Shell 后续新进程采用的并发数上限。',
  apply: 'nextOperation',
  defaultValue: 2,
  schema: z.number().int().min(1).max(8),
});

export const maxRuntimeHoursBackgroundSetting = defineSetting<number>({
  key: 'tools.backgroundProcess.maxRuntimeHours',
  label: '后台进程时长上限（小时）',
  description: '后台 Shell 进程的最长运行时间（小时）。',
  apply: 'nextOperation',
  defaultValue: 24,
  schema: z.number().int().min(1).max(168),
});

/** 整组默认快照(供装配方默认参数与测试),单一事实源是各 setting 的 defaultValue。 */
export const DEFAULT_BACKGROUND_PROCESS_SETTINGS: BackgroundProcessSettings = {
  maxConcurrent: maxConcurrentBackgroundSetting.defaultValue,
  maxRuntimeHours: maxRuntimeHoursBackgroundSetting.defaultValue,
};

/** 聚合读取整块快照:坏值/缺失自动回落默认。 */
export function readBackgroundProcessSettings(
  store: SettingsStore,
): BackgroundProcessSettings {
  return {
    maxConcurrent: store.get(maxConcurrentBackgroundSetting),
    maxRuntimeHours: store.get(maxRuntimeHoursBackgroundSetting),
  };
}
