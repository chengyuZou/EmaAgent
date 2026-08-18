// 测试 prepareLlmCall 的基线切分、compact 改写链、Macro 摘要落库与召回缓存。
import { describe, expect, it, vi } from 'vitest';
import type { AgentBudget } from '@ema-agent/agent';
import type { CompactRequest, CompactResult } from '@ema-agent/compact';
import { PROMPT_DYNAMIC_BOUNDARY } from '@ema-agent/prompts';
import type { Message } from '@ema-agent/llm';
import type { SessionStore } from '@ema-agent/session';
import { ToolPool } from '@ema-agent/tools';
import { createPrepareLlmCall } from '../loop/prepareLlmCall.js';
import type { PreparedTurn } from '../preparation/prepareTurn.js';

const HISTORY: Message[] = [
  { role: 'user', content: '旧消息 1' },
  { role: 'assistant', content: '旧回复 1' },
];
const CURRENT: Message[] = [{ role: 'user', content: '本轮输入' }];

function makePrepared(overrides: Partial<PreparedTurn> = {}): PreparedTurn {
  return {
    executionProfile: 'work',
    workspaceRoot: '/w',
    contextWindow: 100_000,
    maxOutput: 8_000,
    thinkingEnabled: false,
    systemPrompt: ['静态前缀', PROMPT_DYNAMIC_BOUNDARY, '动态尾部'],
    tools: { toolPool: new ToolPool([]) },
    compactSettings: {},
    providerId: 'p',
    modelId: 'm',
    ...overrides,
  } as unknown as PreparedTurn;
}

function makeBudget(remaining = 50_000): AgentBudget {
  return {
    assertWithinLimits: () => undefined,
    remainingOutputTokens: () => remaining,
    recordUsage: () => undefined,
    reserveToolCall: () => undefined,
    enterSubagent: () => () => undefined,
  };
}

function makeDeps(overrides: {
  compact?: (request: CompactRequest) => Promise<CompactResult>;
  sessions?: Pick<SessionStore, 'appendMessage'>;
  reminderSources?: Parameters<typeof createPrepareLlmCall>[0]['reminderSources'];
  prepared?: PreparedTurn;
} = {}) {
  return {
    sessionId: 's1',
    turnId: 't1',
    prepared: overrides.prepared ?? makePrepared(),
    compact: overrides.compact ?? (async request => ({ kind: 'unchanged' as const, history: request.history })),
    sessions: overrides.sessions ?? { appendMessage: vi.fn() },
    emit: vi.fn(),
    budget: makeBudget(),
    baselineMessageCount: HISTORY.length,
    reminderSources: overrides.reminderSources ?? {},
    signal: new AbortController().signal,
  };
}

describe('prepareLlmCall', () => {
  it('未超限时原样装配：请求带模型/工具/输出上限，工作历史不变', async () => {
    const deps = makeDeps();
    const prepare = createPrepareLlmCall(deps);

    const result = await prepare({ messages: [...HISTORY, ...CURRENT] });

    expect(result.request.model).toBe('m');
    expect(result.request.maxOutputTokens).toBe(8_000);
    expect(result.messages).toEqual([...HISTORY, ...CURRENT]);
    // system prompt 哨兵被剥除后进入请求消息，静态前缀在前。
    expect(result.request.messages[0]).toMatchObject({ role: 'system' });
    expect(deps.sessions.appendMessage).not.toHaveBeenCalled();
  });

  it('macro 改写后：摘要落库(kind=summary,turnId=null)、基线重置、历史整体替换', async () => {
    const macroHistory: Message[] = [{ role: 'user', content: '[摘要] 前文压缩' }];
    const appendMessage = vi.fn();
    const deps = makeDeps({
      compact: async () => ({
        kind: 'macro' as const,
        history: macroHistory,
        summary: '前文压缩摘要',
        compactedMessageCount: 2,
      }),
      sessions: { appendMessage },
    });
    const prepare = createPrepareLlmCall(deps);

    const result = await prepare({ messages: [...HISTORY, ...CURRENT] });

    expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      turnId: null,
      sessionId: 's1',
      kind: 'summary',
      blocks: '前文压缩摘要',
    }));
    expect(result.messages).toEqual([...macroHistory, ...CURRENT]);
  });

  it('micro 改写只替换历史、不落摘要', async () => {
    const microHistory: Message[] = [{ role: 'user', content: '旧消息 1（裁剪后）' }];
    const appendMessage = vi.fn();
    const deps = makeDeps({
      compact: async () => ({ kind: 'micro' as const, history: microHistory }),
      sessions: { appendMessage },
    });
    const prepare = createPrepareLlmCall(deps);

    const result = await prepare({ messages: [...HISTORY, ...CURRENT] });

    expect(result.messages).toEqual([...microHistory, ...CURRENT]);
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('Provider 报上下文超限时 compact 收到 force=true', async () => {
    const seen: CompactRequest[] = [];
    const deps = makeDeps({
      compact: async request => {
        seen.push(request);
        return { kind: 'unchanged' as const, history: request.history };
      },
    });
    const prepare = createPrepareLlmCall(deps);

    await prepare({ messages: [...HISTORY, ...CURRENT], recoveryReason: 'context_window_exceeded' });

    expect(seen[0]?.force).toBe(true);
  });

  it('Memory/Narrative 召回同一 Turn 只计算一次', async () => {
    const memoryRecall = vi.fn(async () => '召回内容');
    const deps = makeDeps({ reminderSources: { memoryRecall } });
    const prepare = createPrepareLlmCall(deps);

    await prepare({ messages: [...HISTORY, ...CURRENT] });
    await prepare({ messages: [...HISTORY, ...CURRENT] });

    expect(memoryRecall).toHaveBeenCalledTimes(1);
  });

  it('输出上限取预算与模型上限的较小者', async () => {
    const deps = makeDeps({ prepared: makePrepared({ maxOutput: null }) });
    const prepare = createPrepareLlmCall(deps);

    const result = await prepare({ messages: [...HISTORY, ...CURRENT] });

    expect(result.request.maxOutputTokens).toBe(50_000);
  });
});
