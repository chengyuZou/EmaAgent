// 定义根 Agent 与子 Agent 在下一轮采用的用户可调资源上限。

import { defineSetting } from '@ema-agent/settings';
import { DEFAULT_TURN_BUDGET_LIMITS } from './turn-budget.js';

export interface AgentSettings {
  chatMaxIterations: number;
  workMaxIterations: number;
  maxToolCalls: number;
  maxSubagents: number;
  maxConcurrentSubagents: number;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  chatMaxIterations: 8,
  workMaxIterations: 30,
  maxToolCalls: DEFAULT_TURN_BUDGET_LIMITS.maxToolCalls,
  maxSubagents: DEFAULT_TURN_BUDGET_LIMITS.maxSubagents,
  maxConcurrentSubagents: DEFAULT_TURN_BUDGET_LIMITS.maxConcurrentSubagents,
};

export const agentSetting = defineSetting<AgentSettings>({
  key: 'agent.limits',
  kind: 'object',
  apply: 'nextTurn',
  defaultValue: DEFAULT_AGENT_SETTINGS,
  decode(value) {
    if (!isRecord(value)) return { ok: false };
    const merged = { ...DEFAULT_AGENT_SETTINGS, ...value };
    if (!integerInRange(merged.chatMaxIterations, 1, 30)) return { ok: false };
    if (!integerInRange(merged.workMaxIterations, 1, 100)) return { ok: false };
    if (!integerInRange(merged.maxToolCalls, 1, 512)) return { ok: false };
    if (!integerInRange(merged.maxSubagents, 1, 32)) return { ok: false };
    if (!integerInRange(merged.maxConcurrentSubagents, 1, 8)) return { ok: false };
    if (merged.maxConcurrentSubagents > merged.maxSubagents) return { ok: false };
    return { ok: true, value: merged as AgentSettings };
  },
});

function integerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
