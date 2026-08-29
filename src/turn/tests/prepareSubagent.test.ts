// 测试子 Agent 只继承父工作消息，并为每个 AgentLoop 创建独立 Compact 状态。
import { describe, expect, it, vi } from 'vitest';
import type { AgentBudget } from '@ema-agent/agent';
import type { CallLlm } from '@ema-agent/llm';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import { ToolPool } from '@ema-agent/tools';
import { createPrepareSubagent } from '../loop/prepareSubagent.js';
import type { PreparedTurn } from '../preparation/prepareTurn.js';

const callLlm: CallLlm = async function* () {
  yield { type: 'done', stopReason: 'end_turn' };
};

const budget: AgentBudget = {
  enterSubagent: () => () => undefined,
};

function preparedTurn(): PreparedTurn {
  return {
    providerId: 'p',
    modelId: 'm',
    protocol: 'openai-chat',
    callLlm,
    contextWindow: 100_000,
    maxOutput: 8_000,
    systemPrompt: [{ name: 'root', content: '根提示词' }],
    tools: {
      toolPool: new ToolPool([]),
      createSubagentExecutor: () => undefined,
    },
    maxIterations: 10,
  } as unknown as PreparedTurn;
}

describe('createPrepareSubagent', () => {
  it('fork 继承父工作消息但不继承根 System；每次创建独立 Compact 闭包', async () => {
    const createCompact = vi.fn(() => async (request: { history: readonly unknown[] }) => ({
      kind: 'unchanged' as const,
      history: request.history,
    }));
    const parentMessages = [
      { role: 'user' as const, content: '父工作历史' },
      { role: 'assistant' as const, content: '父回复' },
    ];
    const prepare = createPrepareSubagent({
      sessionId: 's1',
      turnId: 't1',
      prepared: preparedTurn,
      providers: {} as Providers,
      providerModels: {} as ProviderModels,
      createCompact: createCompact as never,
      emit: () => undefined,
      budget,
      parentMessages,
    });

    const signal = new AbortController().signal;
    const first = await prepare({
      agentRunId: 'a1',
      prompt: '查接口',
      options: { contextMode: 'fork' },
      signal,
    });
    const second = await prepare({
      agentRunId: 'a2',
      prompt: '查测试',
      options: { contextMode: 'fork' },
      signal,
    });

    expect(createCompact).toHaveBeenCalledTimes(2);
    expect(first.messages).toEqual([...parentMessages, { role: 'user', content: '查接口' }]);
    expect(second.messages).toEqual([...parentMessages, { role: 'user', content: '查测试' }]);
    expect(first.messages.some(message => message.role === 'system')).toBe(false);
  });
});
