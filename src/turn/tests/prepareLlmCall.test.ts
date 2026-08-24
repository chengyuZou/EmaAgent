// 测试 prepareLlmCall 的基线切分、compact 改写链与 Macro 摘要游标落库。
import { describe, expect, it, vi } from 'vitest';
import type { AgentBudget } from '@ema-agent/agent';
import type { CompactRequest, CompactResult } from '@ema-agent/compact';
import type { Message } from '@ema-agent/llm';
import type { Message as SessionMessage, SessionStore } from '@ema-agent/session';
import { ToolPool } from '@ema-agent/tools';
import { createPrepareLlmCall, type PrepareLlmCallDeps } from '../loop/prepareLlmCall.js';
import type { PreparedTurn } from '../preparation/prepareTurn.js';

const HISTORY: Message[] = [
  { role: 'user', content: '旧消息 1' },
  { role: 'assistant', content: '旧回复 1' },
];
const CURRENT: Message[] = [{ role: 'user', content: '本轮输入' }];
const BASELINE_IDS = ['sm-old-1', 'sm-old-2'];

function makePrepared(overrides: Partial<PreparedTurn> = {}): PreparedTurn {
  return {
    executionProfile: 'work',
    workspaceRoot: '/w',
    contextWindow: 100_000,
    maxOutput: 8_000,
    systemPrompt: [
      { name: 'static', content: '静态前缀', cacheBreakpoint: true },
      { name: 'dynamic', content: '动态尾部' },
    ],
    tools: { toolPool: new ToolPool([]) },
    compactSettings: {},
    providerId: 'p',
    modelId: 'm',
    ...overrides,
  } as unknown as PreparedTurn;
}

function macroCompact(history: Message[], summary: string, count: number) {
  return async (request: CompactRequest): Promise<CompactResult> => {
    // 模拟真实 Compact：保存闭包在返回前被调用（保存成功才发 completed）。
    request.saveMacroSummary?.(summary, count);
    return { kind: 'macro' as const, history, summary, summarizedMessageCount: count };
  };
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
  prepared?: PreparedTurn;
  withPersistence?: boolean;
} = {}) {
  const appendHistorySummary = vi.fn(() => ({ id: 'summary-1' }) as SessionMessage);
  const deps: PrepareLlmCallDeps = {
    sessionId: 's1',
    turnId: 't1',
    prepared: overrides.prepared ?? makePrepared(),
    compact: overrides.compact ?? (async request => ({ kind: 'unchanged' as const, history: request.history })),
    emit: vi.fn(),
    budget: makeBudget(),
    baselineMessageCount: HISTORY.length,
    ...(overrides.withPersistence === false
      ? {}
      : {
          macroPersistence: {
            sessions: { appendHistorySummary } as unknown as Pick<SessionStore, 'appendHistorySummary'>,
            baselineMessageIds: BASELINE_IDS,
          },
        }),
    signal: new AbortController().signal,
  };
  return { deps, appendHistorySummary };
}

describe('prepareLlmCall', () => {
  it('未超限时原样装配：请求带工具/输出上限，工作历史不变', async () => {
    const inherited: Message[][] = [];
    const { deps, appendHistorySummary } = makeDeps();
    const prepare = createPrepareLlmCall({
      ...deps,
      onWorkingMessagesPrepared: messages => inherited.push([...messages]),
    });

    const result = await prepare({ messages: [...HISTORY, ...CURRENT] });

    // 模型身份在 CallLlm 创建点冻结，请求不再携带 model 字段。
    expect('model' in result.request).toBe(false);
    expect(result.request.maxOutputTokens).toBe(8_000);
    expect(result.messages).toEqual([...HISTORY, ...CURRENT]);
    // system prompt 哨兵被剥除后进入请求消息，静态前缀在前。
    expect(result.request.messages[0]).toMatchObject({ role: 'system' });
    expect(inherited).toEqual([[...HISTORY, ...CURRENT]]);
    expect(inherited[0]!.some(message => message.role === 'system')).toBe(false);
    expect(appendHistorySummary).not.toHaveBeenCalled();
  });

  it('macro 改写后：摘要带覆盖游标落库、基线重置、历史整体替换', async () => {
    const macroHistory: Message[] = [{ role: 'user', content: '[摘要] 前文压缩' }];
    const { deps, appendHistorySummary } = makeDeps({
      compact: macroCompact(macroHistory, '前文压缩摘要', 2),
    });
    const prepare = createPrepareLlmCall(deps);

    const result = await prepare({ messages: [...HISTORY, ...CURRENT] });

    // summarizedMessageCount=2 → 游标映射到基线第 2 条的 Session Message id。
    expect(appendHistorySummary).toHaveBeenCalledWith({
      sessionId: 's1',
      summary: '前文压缩摘要',
      summarizedThroughMessageId: 'sm-old-2',
    });
    expect(result.messages).toEqual([...macroHistory, ...CURRENT]);
  });

  it('同 Turn 再次 macro：游标随新基线重定位到上一次持久化的 summary', async () => {
    const firstHistory: Message[] = [{ role: 'user', content: '[摘要一]' }];
    const secondHistory: Message[] = [{ role: 'user', content: '[摘要二]' }];
    let call = 0;
    const { deps, appendHistorySummary } = makeDeps({
      compact: async (request) => {
        call += 1;
        if (call === 1) {
          request.saveMacroSummary?.('摘要一', 2);
          return { kind: 'macro' as const, history: firstHistory, summary: '摘要一', summarizedMessageCount: 2 };
        }
        request.saveMacroSummary?.('摘要二', 1);
        return { kind: 'macro' as const, history: secondHistory, summary: '摘要二', summarizedMessageCount: 1 };
      },
    });
    const prepare = createPrepareLlmCall(deps);

    const first = await prepare({ messages: [...HISTORY, ...CURRENT] });
    await prepare({ messages: first.messages });

    // 第二次 macro 覆盖基线第 1 条 = 第一次落库的 summary 消息本身。
    expect(appendHistorySummary).toHaveBeenNthCalledWith(2, {
      sessionId: 's1',
      summary: '摘要二',
      summarizedThroughMessageId: 'summary-1',
    });
  });

  it('子 Agent 没有 macroPersistence：macro 只替换工作历史，不落库', async () => {
    const macroHistory: Message[] = [{ role: 'user', content: '[子 Agent 摘要]' }];
    const { deps, appendHistorySummary } = makeDeps({
      withPersistence: false,
      compact: async () => ({
        kind: 'macro' as const,
        history: macroHistory,
        summary: '子 Agent 摘要',
        summarizedMessageCount: 2,
      }),
    });
    const prepare = createPrepareLlmCall(deps);

    const result = await prepare({ messages: [...HISTORY, ...CURRENT] });

    expect(result.messages).toEqual([...macroHistory, ...CURRENT]);
    expect(appendHistorySummary).not.toHaveBeenCalled();
  });

  it('micro 改写只替换历史、不落摘要', async () => {
    const microHistory: Message[] = [{ role: 'user', content: '旧消息 1（裁剪后）' }];
    const { deps, appendHistorySummary } = makeDeps({
      compact: async () => ({ kind: 'micro' as const, history: microHistory }),
    });
    const prepare = createPrepareLlmCall(deps);

    const result = await prepare({ messages: [...HISTORY, ...CURRENT] });

    expect(result.messages).toEqual([...microHistory, ...CURRENT]);
    expect(appendHistorySummary).not.toHaveBeenCalled();
  });

  it('Provider 报上下文超限时 compact 收到 force=true', async () => {
    const seen: CompactRequest[] = [];
    const { deps } = makeDeps({
      compact: async request => {
        seen.push(request);
        return { kind: 'unchanged' as const, history: request.history };
      },
    });
    const prepare = createPrepareLlmCall(deps);

    await prepare({ messages: [...HISTORY, ...CURRENT], recoveryReason: 'context_window_exceeded' });

    expect(seen[0]?.force).toBe(true);
  });

  it('输出上限取预算与模型上限的较小者', async () => {
    const { deps } = makeDeps({ prepared: makePrepared({ maxOutput: null }) });
    const prepare = createPrepareLlmCall(deps);

    const result = await prepare({ messages: [...HISTORY, ...CURRENT] });

    expect(result.request.maxOutputTokens).toBe(50_000);
  });
});
