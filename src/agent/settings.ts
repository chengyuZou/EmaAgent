import type { SettingsStore } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings/definition';
import { z } from 'zod';

export interface AgentSettings {
  maxIterations: number;
  maxConcurrentSubagents: number;
}

export const maxIterationsSetting = defineSetting({
  key: 'agent.limits.maxIterations',
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

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  maxIterations: maxIterationsSetting.defaultValue,
  maxConcurrentSubagents: maxConcurrentSubagentsSetting.defaultValue,
};

export const AGENT_LIMITS_SETTINGS = [
  maxIterationsSetting,
  maxConcurrentSubagentsSetting,
] as const;

export function readAgentSettings(store: SettingsStore): AgentSettings {
  return {
    maxIterations: store.get(maxIterationsSetting),
    maxConcurrentSubagents: store.get(maxConcurrentSubagentsSetting),
  };
}
