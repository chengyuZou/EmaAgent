// Agent 执行限制:拆细为一字段一 key(独立校验/独立变更事件/独立 UI 控件),
// 迭代数和子代理并发数按独立 key 保存.
// 消费方(turnExecution)仍要整组快照,由 readAgentSettings(store) 聚合读取。

import type { SettingsStore } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

export interface AgentSettings {
  chatMaxIterations: number;
  workMaxIterations: number;
  maxConcurrentSubagents: number;
}

export const chatMaxIterationsSetting = defineSetting({
  key: 'agent.limits.chatMaxIterations',
  apply: 'nextTurn',
  defaultValue: 20,
  schema: z.number().int().min(10).max(30),
});

export const workMaxIterationsSetting = defineSetting({
  key: 'agent.limits.workMaxIterations',
  apply: 'nextTurn',
  defaultValue: 50,
  schema: z.number().int().min(30).max(100),
});

export const maxConcurrentSubagentsSetting = defineSetting({
  key: 'agent.limits.maxConcurrentSubagents',
  apply: 'nextTurn',
  defaultValue: 4,
  schema: z.number().int().min(1).max(8),
});

/**
 * 整组默认快照(供消费方默认参数与测试使用)。
 * 单一事实源是各 setting 的 defaultValue,这里只是聚合导出,不再手写重复值。
 */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  chatMaxIterations: chatMaxIterationsSetting.defaultValue,
  workMaxIterations: workMaxIterationsSetting.defaultValue,
  maxConcurrentSubagents: maxConcurrentSubagentsSetting.defaultValue,
};

/** Agent 设置定义目录. */
export const AGENT_LIMITS_SETTINGS = [
  chatMaxIterationsSetting,
  workMaxIterationsSetting,
  maxConcurrentSubagentsSetting,
] as const;

/**
 * 聚合读取整组快照:逐个 key 从 store 读取(坏值/缺失自动回落默认),
 * 组装成消费方需要的不可变 AgentSettings。每个 key 都是 JSON 原生数字,
 * 读取侧不重复校验.
 */
export function readAgentSettings(store: SettingsStore): AgentSettings {
  return {
    chatMaxIterations: store.get(chatMaxIterationsSetting),
    workMaxIterations: store.get(workMaxIterationsSetting),
    maxConcurrentSubagents: store.get(maxConcurrentSubagentsSetting),
  };
}
