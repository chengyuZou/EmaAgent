import { describe, expect, it, vi } from 'vitest';
import type { CompactRequest, CompactResult } from '@ema-agent/compact';
import type { LLMRequest, Message as ModelMessage } from '@ema-agent/llm';
import type { Message as SessionMessage } from '@ema-agent/session';
import { ToolPool } from '@ema-agent/tools';
import { buildCompactPrompt } from '../../compact/compactPrompt.js';
import { createSummaryMessage } from '../../compact/budget.js';
import { createCompact } from '../../compact/compactMessages.js';
import { DEFAULT_COMPACT_SETTINGS } from '../../compact/settings.js';
import {
  createPrepareAgentIteration,
  type PrepareAgentIterationDeps,
} from '../prepare/prepareAgentIteration.js';
import type { PreparedTurn } from '../prepare/prepareTurn.js';

const MESSAGES: ModelMessage[] = [
  { role: 'user', content: '旧问题' },
  { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] },
  { role: 'user', content: '本 Turn 的 reminder' },
  { role: 'user', content: '本 Turn 的输入' },
];

function makePrepared(overrides: Partial<PreparedTurn> = {}): PreparedTurn {
  return {
    contextWindow: 100_000,
    maxOutput: 8_000,
    systemPrompt: [{ content: '系统提示词', cacheBreakpoint: true }],
    tools: { toolPool: new ToolPool([]) },
    compactSettings: {},
    providerId: 'p',
    modelId: 'm',
    protocol: 'openai-llm',
    supportsImageInput: true,
    callLLM: async function* () { yield { type: 'done', stopReason: 'end_turn' }; },
    completeLLM: async () => ({
      blocks: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    ...overrides,
  } as unknown as PreparedTurn;
}

function macroResult(messages: readonly ModelMessage[], count: number): CompactResult {
  return {
    kind: 'macro',
    messages,
    beforeTokens: 100,
    afterTokens: 20,
    savedTokens: 80,
    durationMs: 1,
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
  const appendHistorySummary = vi.fn((_input: {
    sessionId: string; turnId: string; summary: string; savedTokens: number; summarizedThroughMessageId: string;
  }) => {
    summaryNumber += 1;
    return { id: `summary-${summaryNumber}` } as SessionMessage;
  });
  const deps: PrepareAgentIterationDeps = {
    sessionId: 's1',
    turnId: 't1',
    prepared: makePrepared(),
    createCompact: () => overrides.compact ?? (async request => ({ kind: 'unchanged', messages: request.messages })),
    emit: vi.fn(),
    ...(overrides.persist === false ? {} : {
      macroPersistence: {
        appendSummary: (summary, throughMessageId, savedTokens) => appendHistorySummary({
          sessionId: 's1', turnId: 't1', summary, savedTokens, summarizedThroughMessageId: throughMessageId,
        }),
        messageIds,
      },
    }),
    signal: new AbortController().signal,
  };
  return { deps, messageIds, appendHistorySummary };
}

describe('prepareAgentIteration', () => {
  it('Macro 编排保留工具原图, 交给当前 LLM 协议转换', async () => {
    const requests: LLMRequest[] = [];
    const messages: readonly ModelMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', args: {} }] },
      { role: 'user', content: [{
        type: 'tool_result',
        toolCallId: 'read-1',
        content: [{ type: 'image_data', data: 'YWJj', mimeType: 'image/png' }],
      }] },
      { role: 'user', content: '历史说明 '.repeat(800) },
      { role: 'user', content: '最新问题' },
    ];
    const { deps } = makeDeps({ persist: false });
    const prepare = createPrepareAgentIteration({
      ...deps,
      prepared: makePrepared({
        contextWindow: 8_192,
        maxOutput: 1_000,
        supportsImageInput: true,
        compactSettings: DEFAULT_COMPACT_SETTINGS,
        completeLLM: async (request) => {
          requests.push(request);
          return {
            blocks: [{ type: 'text', text: '<summary>工具图片未提供</summary>' }],
            stopReason: 'end_turn',
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        },
      }),
      createCompact,
    });

    const result = await prepare({ llmCallId: 'call-1', messages, recoveryReason: 'context_window_exceeded' });

    expect(requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(requests)).toContain('"type":"image_data"');
    expect(JSON.stringify(requests)).not.toContain('工具图片未提供:');
    expect(result.messages[0]).toMatchObject({ content: expect.stringContaining('工具图片未提供') });
    expect(messages[1]).toMatchObject({ content: [{ content: [{ type: 'image_data' }] }] });
  });

  it('新工具图片和后续请求保留原图, 不改 AgentLoop 原始历史', async () => {
    const messages: readonly ModelMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', args: {} }] },
      { role: 'user', content: [{
        type: 'tool_result',
        toolCallId: 'read-1',
        content: [{ type: 'image_data', data: 'YWJj', mimeType: 'image/png' }],
      }] },
    ];
    const { deps } = makeDeps({ persist: false });
    const prepare = createPrepareAgentIteration({
      ...deps,
      prepared: makePrepared({ supportsImageInput: false }),
    });

    const first = await prepare({ llmCallId: 'call-1', messages });
    const second = await prepare({ llmCallId: 'call-2', messages: first.messages });

    expect(first.messages).toBe(messages);
    expect(second.messages).toBe(messages);
    expect(first.request.messages.at(-1)).toMatchObject({ content: [{
      type: 'tool_result',
      toolCallId: 'read-1',
      content: [{ type: 'image_data', data: 'YWJj', mimeType: 'image/png' }],
    }] });
    expect(second.request.messages.at(-1)).toEqual(first.request.messages.at(-1));
  });

  it('压缩统一保留工作状态和交流上下文, 摘要外层不带模式', () => {
    const prompt = buildCompactPrompt();
    expect(prompt).toContain('Current Objective and State');
    expect(prompt).toContain('Interaction Context');
    expect(prompt).toContain('both task state and interaction context');
    expect(prompt).not.toContain('Session currently uses');
    expect(createSummaryMessage('进度与对话')).toEqual({
      role: 'user',
      content: '<context-summary>\n进度与对话\n</context-summary>',
    });
  });

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
    expect(seen[0]).not.toHaveProperty('sessionMode');
    expect(result.messages).toEqual(MESSAGES);
    expect(result.request.messages[0]?.role).toBe('system');
    expect(result.request.messages.slice(1).map(message => message.role))
      .toEqual(MESSAGES.map(message => message.role));
    expect(result.request.maxOutputTokens).toBe(8_000);
  });

  it('Macro 可覆盖本 Turn 输入, 游标指向该输入的 SQL ID', async () => {
    const summary: ModelMessage = { role: 'user', content: '摘要' };
    const { deps, messageIds, appendHistorySummary } = makeDeps({
      compact: async request => {
        request.saveMacroSummary?.('摘要', 4, 80);
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
      savedTokens: 80,
      summarizedThroughMessageId: 'input-1',
    });
    expect(messageIds).toEqual(['summary-1']);
    expect(result.messages).toEqual([summary]);
    expect(result.request.messages[1]).toEqual({ ...summary, cacheBreakpoint: true });
  });

  it('连续 Macro 用上次摘要作为游标, 不按第几条 SQL 行猜测', async () => {
    const first: ModelMessage = { role: 'user', content: '摘要一' };
    const second: ModelMessage = { role: 'user', content: '摘要二' };
    let call = 0;
    const { deps, messageIds, appendHistorySummary } = makeDeps({
      compact: async request => {
        call += 1;
        if (call === 1) {
          request.saveMacroSummary?.('摘要一', 2, 80);
          return macroResult([first, ...request.messages.slice(2)], 2);
        }
        request.saveMacroSummary?.('摘要二', 1, 80);
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
      savedTokens: 80,
      summarizedThroughMessageId: 'summary-1',
    });
    expect(messageIds).toEqual(['summary-2', 'reminder-1', 'input-1']);
  });

  it('模型专用引导没有 SQL 行, 游标回退到覆盖前缀的最后一条已落库消息', async () => {
    const messages = [...MESSAGES, { role: 'user', content: 'stuck guide' } satisfies ModelMessage];
    const { deps, messageIds, appendHistorySummary } = makeDeps({
      messageIds: ['old-1', 'old-2', 'reminder-1', 'input-1', undefined],
      compact: async request => {
        request.saveMacroSummary?.('摘要', 5, 80);
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
    const changed = [{ role: 'user', content: '压短的旧问题' } satisfies ModelMessage, ...MESSAGES.slice(1)];
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
    const changed = [{ role: 'user', content: '子 Agent 摘要' } satisfies ModelMessage];
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
