// 验证完整消息链参与压缩, 以及 Macro 覆盖前缀到 SQL 消息 ID 的映射。
import { describe, expect, it, vi } from 'vitest';
import type { CompactRequest, CompactResult } from '@ema-agent/compact';
import type { Message } from '@ema-agent/llm';
import type { Message as SessionMessage, SessionStore } from '@ema-agent/session';
import { ToolPool } from '@ema-agent/tools';
import {
  createPrepareAgentIteration,
  type PrepareAgentIterationDeps,
} from '../prepare/prepareAgentIteration.js';
import type { PreparedTurn } from '../prepare/prepareTurn.js';

const MESSAGES: Message[] = [
  { role: 'user', content: '旧问题' },
  { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] },
  { role: 'user', content: '本 Turn 的 reminder' },
  { role: 'user', content: '本 Turn 的输入' },
];

function makePrepared(overrides: Partial<PreparedTurn> = {}): PreparedTurn {
  return {
    sessionMode: 'work',
    contextWindow: 100_000,
    maxOutput: 8_000,
    systemPrompt: [{ name: 'static', content: '系统提示词', cacheBreakpoint: true }],
    tools: { toolPool: new ToolPool([]) },
    compactSettings: {},
    providerId: 'p',
    modelId: 'm',
    ...overrides,
  } as unknown as PreparedTurn;
}

function macroResult(messages: readonly Message[], count: number): CompactResult {
  return {
    kind: 'macro',
    messages,
    beforeTokens: 100,
    afterTokens: 20,
    savedTokens: 80,
    durationMs: 1,
    usage: { inputTokens: 20, outputTokens: 5 },
    summarizedMessageCount: count,
  };
}

function makeDeps(overrides: {
  compact?: (request: CompactRequest) => Promise<CompactResult>;
  messageIds?: (string | undefined)[];
  persist?: boolean;
} = {}) {
  const messageIds = overrides.messageIds ?? ['old-1', 'old-2', 'reminder-1', 'input-1'];
  let summaryNumber = 0;
  const appendHistorySummary = vi.fn(() => {
    summaryNumber += 1;
    return { id: `summary-${summaryNumber}` } as SessionMessage;
  });
  const deps: PrepareAgentIterationDeps = {
    sessionId: 's1',
    turnId: 't1',
    prepared: makePrepared(),
    compact: overrides.compact ?? (async request => ({ kind: 'unchanged', messages: request.messages })),
    emit: vi.fn(),
    ...(overrides.persist === false ? {} : {
      macroPersistence: {
        sessions: { appendHistorySummary } as unknown as Pick<SessionStore, 'appendHistorySummary'>,
        messageIds,
      },
    }),
    signal: new AbortController().signal,
  };
  return { deps, messageIds, appendHistorySummary };
}

describe('prepareAgentIteration', () => {
  it('不压缩时原样保留完整消息链, System 只进入本次请求', async () => {
    const seen: CompactRequest[] = [];
    const { deps } = makeDeps({
      compact: async request => {
        seen.push(request);
        return { kind: 'unchanged', messages: request.messages };
      },
    });

    const result = await createPrepareAgentIteration(deps)({
      llmCallId: 'call-1',
      messages: MESSAGES,
    });

    expect(seen[0]?.messages).toEqual(MESSAGES);
    expect(result.messages).toEqual(MESSAGES);
    expect(result.request.messages[0]?.role).toBe('system');
    expect(result.request.messages.slice(1).map(message => message.role))
      .toEqual(MESSAGES.map(message => message.role));
    expect(result.request.maxOutputTokens).toBe(8_000);
  });

  it('Macro 可覆盖本 Turn 输入, 游标指向该输入的 SQL ID', async () => {
    const summary: Message = { role: 'user', content: '摘要' };
    const { deps, messageIds, appendHistorySummary } = makeDeps({
      compact: async request => {
        request.saveMacroSummary?.('摘要', 4);
        return macroResult([summary], 4);
      },
    });

    const result = await createPrepareAgentIteration(deps)({
      llmCallId: 'call-1',
      messages: MESSAGES,
    });

    expect(appendHistorySummary).toHaveBeenCalledWith({
      sessionId: 's1',
      turnId: 't1',
      summary: '摘要',
      summarizedThroughMessageId: 'input-1',
    });
    expect(messageIds).toEqual(['summary-1']);
    expect(result.messages).toEqual([summary]);
    expect(result.request.messages[1]).toEqual({ ...summary, cacheBreakpoint: true });
  });

  it('连续 Macro 用上次摘要作为游标, 不按第几条 SQL 行猜测', async () => {
    const first: Message = { role: 'user', content: '摘要一' };
    const second: Message = { role: 'user', content: '摘要二' };
    let call = 0;
    const { deps, messageIds, appendHistorySummary } = makeDeps({
      compact: async request => {
        call += 1;
        if (call === 1) {
          request.saveMacroSummary?.('摘要一', 2);
          return macroResult([first, ...request.messages.slice(2)], 2);
        }
        request.saveMacroSummary?.('摘要二', 1);
        return macroResult([second, ...request.messages.slice(1)], 1);
      },
    });
    const prepare = createPrepareAgentIteration(deps);
    const firstCall = await prepare({ llmCallId: 'call-1', messages: MESSAGES });
    await prepare({ llmCallId: 'call-2', messages: firstCall.messages });

    expect(appendHistorySummary).toHaveBeenNthCalledWith(2, {
      sessionId: 's1',
      turnId: 't1',
      summary: '摘要二',
      summarizedThroughMessageId: 'summary-1',
    });
    expect(messageIds).toEqual(['summary-2', 'reminder-1', 'input-1']);
  });

  it('模型专用引导没有 SQL 行, 游标回退到覆盖前缀的最后一条已落库消息', async () => {
    const messages = [...MESSAGES, { role: 'user', content: 'stuck guide' } satisfies Message];
    const { deps, messageIds, appendHistorySummary } = makeDeps({
      messageIds: ['old-1', 'old-2', 'reminder-1', 'input-1', undefined],
      compact: async request => {
        request.saveMacroSummary?.('摘要', 5);
        return macroResult([{ role: 'user', content: '摘要' }], 5);
      },
    });

    await createPrepareAgentIteration(deps)({ llmCallId: 'call-1', messages });

    expect(appendHistorySummary).toHaveBeenCalledWith(expect.objectContaining({
      summarizedThroughMessageId: 'input-1',
    }));
    expect(messageIds).toEqual(['summary-1']);
  });

  it('Micro 原位改写消息, 不写 SQL 摘要', async () => {
    const changed = [{ role: 'user', content: '压短的旧问题' } satisfies Message, ...MESSAGES.slice(1)];
    const { deps, appendHistorySummary } = makeDeps({
      compact: async () => ({ kind: 'micro', messages: changed }),
    });

    const result = await createPrepareAgentIteration(deps)({
      llmCallId: 'call-1',
      messages: MESSAGES,
    });

    expect(result.messages).toEqual(changed);
    expect(appendHistorySummary).not.toHaveBeenCalled();
  });

  it('子 Agent 只改自己的模型消息, 不写根 Session 摘要', async () => {
    const changed = [{ role: 'user', content: '子 Agent 摘要' } satisfies Message];
    const { deps, appendHistorySummary } = makeDeps({
      persist: false,
      compact: async () => macroResult(changed, MESSAGES.length),
    });

    const result = await createPrepareAgentIteration(deps)({
      llmCallId: 'call-1',
      messages: MESSAGES,
    });

    expect(result.messages).toEqual(changed);
    expect(appendHistorySummary).not.toHaveBeenCalled();
  });

  it('Provider 报上下文超限时向 Compact 传 force=true', async () => {
    const seen: CompactRequest[] = [];
    const { deps } = makeDeps({
      compact: async request => {
        seen.push(request);
        return { kind: 'unchanged', messages: request.messages };
      },
    });

    await createPrepareAgentIteration(deps)({
      llmCallId: 'call-recovery',
      messages: MESSAGES,
      recoveryReason: 'context_window_exceeded',
    });

    expect(seen[0]?.force).toBe(true);
  });
});
