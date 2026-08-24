// Agent 执行限制:拆细为一字段一 key(独立校验/独立变更事件/独立 UI 控件),
// 但 5 个 key 之间存在跨字段约束(maxConcurrentSubagents ≤ maxSubagents),
// 故声明 group 'agent.limits' 让 SettingsStore 写入时整组 refine。
// 消费方(turnExecution)仍要整组快照,由 readAgentSettings(store) 聚合读取。

import type { SettingsStore, SettingGroup } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import type { LlmThinkingEffort } from '@ema-agent/llm';
import { z } from 'zod';

export interface AgentSettings {
  chatMaxIterations: number;
  workMaxIterations: number;
  maxToolCalls: number;
  maxSubagents: number;
  maxConcurrentSubagents: number;
  /** 开启 thinking 的 Turn 使用的中立强度档（协议各自映射，nextTurn 生效）。 */
  thinkingEffort: LlmThinkingEffort;
}

export const AGENT_LIMITS_GROUP = 'agent.limits';

export const chatMaxIterationsSetting = defineSetting<number>({
  key: 'agent.limits.chatMaxIterations',
  label: 'Chat 单轮迭代上限',
  description: 'Chat 模式单 Turn 最大迭代次数。',
  apply: 'nextTurn',
  defaultValue: 20,
  schema: z.number().int().min(1).max(30),
  group: AGENT_LIMITS_GROUP,
});

export const workMaxIterationsSetting = defineSetting<number>({
  key: 'agent.limits.workMaxIterations',
  label: 'Work 单轮迭代上限',
  description: 'Work 模式单 Turn 最大迭代次数。',
  apply: 'nextTurn',
  defaultValue: 50,
  schema: z.number().int().min(1).max(100),
  group: AGENT_LIMITS_GROUP,
});

export const maxToolCallsSetting = defineSetting<number>({
  key: 'agent.limits.maxToolCalls',
  label: '单轮工具调用上限',
  description: '单 Turn 最大工具调用次数。',
  apply: 'nextTurn',
  defaultValue: 512,
  schema: z.number().int().min(1).max(512),
  group: AGENT_LIMITS_GROUP,
});

export const maxSubagentsSetting = defineSetting<number>({
  key: 'agent.limits.maxSubagents',
  label: '单轮子代理上限',
  description: '单 Turn 最大子代理数。',
  apply: 'nextTurn',
  defaultValue: 16,
  schema: z.number().int().min(1).max(32),
  group: AGENT_LIMITS_GROUP,
});

export const maxConcurrentSubagentsSetting = defineSetting<number>({
  key: 'agent.limits.maxConcurrentSubagents',
  label: '并发子代理上限',
  description: '最大并发子代理数（不能大于最大子代理数）。',
  apply: 'nextTurn',
  defaultValue: 4,
  schema: z.number().int().min(1).max(8),
  group: AGENT_LIMITS_GROUP,
});

/**
 * 中立推理强度档：不属于 agent.limits 组（无跨字段约束），单独注册。
 * 消费方是 Turn 冻结的 thinking 配置；协议 Adapter 各自映射为档位参数或预算。
 */
export const thinkingEffortSetting = defineSetting<LlmThinkingEffort>({
  key: 'agent.thinking.effort',
  label: '思考强度',
  description: '模型内部推理的强度档位；开启 thinking 的 Turn 生效，各协议映射为对应参数。',
  apply: 'nextTurn',
  defaultValue: 'medium',
  schema: z.enum(['low', 'medium', 'high', 'max']),
});

/**
 * 整组默认快照(供消费方默认参数与测试使用)。
 * 单一事实源是各 setting 的 defaultValue,这里只是聚合导出,不再手写重复值。
 */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  chatMaxIterations: chatMaxIterationsSetting.defaultValue,
  workMaxIterations: workMaxIterationsSetting.defaultValue,
  maxToolCalls: maxToolCallsSetting.defaultValue,
  maxSubagents: maxSubagentsSetting.defaultValue,
  maxConcurrentSubagents: maxConcurrentSubagentsSetting.defaultValue,
  thinkingEffort: thinkingEffortSetting.defaultValue,
};

/** agent.limits 组内全部字段定义(供 SettingsStore 注册组)。 */
export const AGENT_LIMITS_SETTINGS = [
  chatMaxIterationsSetting,
  workMaxIterationsSetting,
  maxToolCallsSetting,
  maxSubagentsSetting,
  maxConcurrentSubagentsSetting,
] as const;

/**
 * agent.limits 设置组:跨字段约束 maxConcurrentSubagents ≤ maxSubagents。
 * 用户把 maxSubagents 改小到低于当前 maxConcurrentSubagents 时,
 * SettingsStore 用本组 schema 整组 refine 拦截(拒绝落库)。
 */
export const agentLimitsGroup: SettingGroup = {
  id: AGENT_LIMITS_GROUP,
  definitions: AGENT_LIMITS_SETTINGS,
  schema: z
    .object({
      'agent.limits.chatMaxIterations': z.number(),
      'agent.limits.workMaxIterations': z.number(),
      'agent.limits.maxToolCalls': z.number(),
      'agent.limits.maxSubagents': z.number(),
      'agent.limits.maxConcurrentSubagents': z.number(),
    })
    .refine(
      g => g['agent.limits.maxConcurrentSubagents'] <= g['agent.limits.maxSubagents'],
      { message: 'maxConcurrentSubagents 不能大于 maxSubagents' },
    ),
};

/**
 * 聚合读取整组快照:逐个 key 从 store 读取(坏值/缺失自动回落默认),
 * 组装成消费方需要的不可变 AgentSettings。每个 key 都是 JSON 原生数字,
 * 组内跨字段约束由 SettingsStore 写入时保证,读取侧无需再验。
 */
export function readAgentSettings(store: SettingsStore): AgentSettings {
  return {
    chatMaxIterations: store.get(chatMaxIterationsSetting),
    workMaxIterations: store.get(workMaxIterationsSetting),
    maxToolCalls: store.get(maxToolCallsSetting),
    maxSubagents: store.get(maxSubagentsSetting),
    maxConcurrentSubagents: store.get(maxConcurrentSubagentsSetting),
    thinkingEffort: store.get(thinkingEffortSetting),
  };
}
