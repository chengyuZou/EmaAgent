// 验证 Compact 的提交原子性、响应式恢复、取消、熔断和 Tool 配对边界。

import { describe, expect, it, vi } from 'vitest';
import type {
  CallLlm,
  LlmCompletion,
  LlmRequest,
  Message,
} from '@ema-agent/llm';
import { estimateLlmInputTokens, estimateMessagesTokens } from '@ema-agent/token';
import type { CompactEvent } from '../events.js';
import { createCompact } from '../compactMessages.js';
import { microCompact } from '../microCompact.js';
import type { CompactRequest } from '../types.js';

const sessionId = 'compact-session';

function completion(text = '<summary>压缩后的工作摘要</summary>'): LlmCompletion {
  return {
    blocks: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 100, outputTokens: 20 },
  };
}

function llmCompleting(
  complete: (request: LlmRequest) => Promise<LlmCompletion>,
): CallLlm {
  return (request: LlmRequest) => (async function* () {
    const result = await complete(request);
    let blockIndex = 0;
    for (const block of result.blocks) {
      if (block.type === 'text') {
        yield { type: 'text_delta' as const, blockIndex: blockIndex++, delta: block.text };
      }
    }
    yield { type: 'done' as const, stopReason: result.stopReason };
  })();
}

function request(history: readonly Message[], overrides: Partial<CompactRequest> = {}): CompactRequest {
  return {
    sessionId,

    executionProfile: 'work' as const,
    history,
    systemMessages: [{ role: 'system', content: '产品系统提示' }],
    tools: [],
    estimatedInputTokens: estimateMessagesTokens([...history]),
    contextWindow: 4_000,
    maxOutputTokens: 0,
    ...overrides,
  };
}

function textHistory(count = 20, repeat = 80): Message[] {
  return Array.from({ length: count }, (_, index): Message => index % 2 === 0
    ? { role: 'user', content: `user-${index} ${'long context '.repeat(repeat)}` }
    : {
        role: 'assistant',
        content: [{ type: 'text', text: `assistant-${index} ${'long context '.repeat(repeat)}` }],
      });
}

function readHistory(count = 8, repeat = 200): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < count; index += 1) {
    messages.push({
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: `read-${index}`,
        name: 'Read',
        args: { file_path: `file-${index}.ts` },
      }],
    });
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        toolCallId: `read-${index}`,
        content: `result-${index} ${'file content '.repeat(repeat)}`,
      }],
    });
  }
  return messages;
}

describe('createCompact', () => {
  it('低于阈值时原样返回历史且不调用模型', async () => {
    const complete = vi.fn(async (_request: LlmRequest) => completion());
    const history: Message[] = [{ role: 'user', content: 'short' }];
    const compact = createCompact(llmCompleting(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
    });

    const result = await compact(request(history, { contextWindow: 100_000 }));

    expect(result).toEqual({ kind: 'unchanged', history });
    expect(complete).not.toHaveBeenCalled();
  });

  it('Micro 足以恢复预算时直接返回清理后的历史', async () => {
    const complete = vi.fn(async () => completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
      keepRecentToolResults: 1,
    });

    const result = await compact(request(readHistory(), { contextWindow: 1_500 }));

    expect(result.kind).toBe('micro');
    expect(JSON.stringify(result.history).match(/Old tool result content cleared/gu)).toHaveLength(7);
    expect(estimateMessagesTokens([...result.history])).toBeLessThan(estimateMessagesTokens(readHistory()));
    expect(complete).not.toHaveBeenCalled();
  });

  it('Micro 保留原 Tool Result 的错误事实', () => {
    const history = readHistory(3, 10);
    const firstResult = history[1]!;
    if (firstResult.role !== 'user' || typeof firstResult.content === 'string') {
      throw new Error('测试夹具不是 Tool Result');
    }
    firstResult.content = [
      {
        type: 'tool_result',
        toolCallId: 'read-0',
        content: 'read failed',
        isError: true,
      },
      ...firstResult.content.slice(1),
    ];

    const result = microCompact(history, { keepRecent: 1 });
    const cleared = result[1]!;
    expect(cleared.role).toBe('user');
    if (cleared.role !== 'user' || typeof cleared.content === 'string') return;
    expect(cleared.content[0]).toMatchObject({
      type: 'tool_result',
      content: 'read failed',
      isError: true,
    });
  });

  it('Macro 失败时丢弃中间 Micro 改写并原样返回历史', async () => {
    const complete = vi.fn(async () => { throw new Error('provider unavailable'); });
    const history = readHistory();
    const compact = createCompact(llmCompleting(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
      keepRecentToolResults: 1,
    });

    const events: CompactEvent[] = [];
    const result = await compact(request(history, {
      force: true,
      onEvent: (event) => events.push(event),
    }));

    expect(result).toEqual({ kind: 'unchanged', history });
    expect(events.at(-1)).toMatchObject({
      type: 'compact_failed',
      error: 'provider unavailable',
    });
  });

  it('取消直接上抛，不发送失败事件也不打开熔断', async () => {
    const controller = new AbortController();
    const events: CompactEvent[] = [];
    const complete = vi.fn()
      .mockImplementationOnce(async () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      })
      .mockResolvedValue(completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
      maximumConsecutiveFailures: 1,
    });

    await expect(compact(request(textHistory(), {
      force: true,
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    }))).rejects.toMatchObject({ name: 'AbortError' });

    expect(events.map((event) => event.type)).toEqual([
      'compact_started',
      'compact_cancelled',
    ]);
    const success = await compact(request(textHistory(), { force: true }));
    expect(JSON.stringify(success)).toContain('压缩后的工作摘要');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('响应式压缩绕过自动关闭和连续失败熔断', async () => {
    const events: CompactEvent[] = [];
    const complete = vi.fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValue(completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
      maximumConsecutiveFailures: 1,
    });

    const history = textHistory();
    expect(await compact(request(history, {
      onEvent: (event) => events.push(event),
    }))).toEqual({ kind: 'unchanged', history });
    expect(events.at(-1)?.type).toBe('compact_failed');
    expect(await compact(request(history))).toEqual({ kind: 'unchanged', history });
    expect(complete).toHaveBeenCalledTimes(1);
    const forced = await compact(request(textHistory(), {
      force: true,
      settings: {
        enabled: false,
        bufferTokens: 0,
        defaultReservedOutputTokens: 0,
        maximumReservedOutputTokens: 0,
        keepRecentToolResults: 6,
        maximumConsecutiveFailures: 1,
        retainRatio: 0.16,
      },
    }));
    expect(JSON.stringify(forced)).toContain('压缩后的工作摘要');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('单条超大历史也会进入 Macro，而不是误判为历史不足', async () => {
    const complete = vi.fn(async (_request: LlmRequest) => completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
    });
    const history: Message[] = [{ role: 'user', content: 'huge '.repeat(20_000) }];

    const result = await compact(request(history, {
      force: true,
      contextWindow: 4_000,
    }));

    expect(result).toMatchObject({
      kind: 'macro',
      summary: '压缩后的工作摘要',
      summarizedMessageCount: 1,
    });
    expect(JSON.stringify(result.history)).toContain('压缩后的工作摘要');
    expect(complete).toHaveBeenCalledTimes(1);
    // 摘要请求 = 系统段 + 结构化历史原文 + 尾部压缩指令（不再扁平化成单条文本）。
    const sent = complete.mock.calls[0]?.[0]?.messages;
    expect(sent?.[0]).toMatchObject({ role: 'system', content: '产品系统提示' });
    expect(String(sent?.[1]?.content)).toContain('huge');
    expect(String(sent?.at(-1)?.content)).toContain('compact agent');
  });

  it('摘要请求透传根 Turn 冻结的 tools 与 thinking 配置', async () => {
    const complete = vi.fn(async (_request: LlmRequest) => completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
    });
    const frozenTools = [{ name: 'Read', description: '读取文件', inputSchema: { type: 'object' } }];

    const result = await compact(request(textHistory(), {
      force: true,
      tools: frozenTools,
      thinking: { enabled: true, effort: 'high' },
    }));

    expect(result.kind).toBe('macro');
    const sent = complete.mock.calls[0]?.[0];
    expect(sent?.tools).toEqual(frozenTools);
    expect(sent?.thinking).toEqual({ enabled: true, effort: 'high' });
  });

  it('摘要请求的最大输出额度扣除 Tool Schema 占用', async () => {
    const complete = vi.fn(async (_request: LlmRequest) => completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
    });
    const tools = [{
      name: 'Read',
      description: '读取文件并返回内容'.repeat(80),
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: '绝对文件路径'.repeat(40) } },
      },
    }];

    await compact(request(textHistory(), {
      force: true,
      contextWindow: 4_000,
      tools,
    }));

    const sent = complete.mock.calls[0]![0];
    const toolTokens = estimateLlmInputTokens([], {
      tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
    }).totalTokens;
    const availableOutput = Math.max(
      1,
      4_000 - estimateMessagesTokens([...sent.messages]) - toolTokens,
    );
    expect(sent.maxOutputTokens).toBeLessThanOrEqual(availableOutput);
  });

  it('摘要模型判超时按 Token 预算从尾部收缩历史并重试，指令如实标注丢弃数', async () => {
    const complete = vi.fn()
      .mockRejectedValueOnce(new Error('prompt is too long for this model'))
      .mockResolvedValue(completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
    });

    const result = await compact(request(textHistory(), { force: true }));

    expect(result.kind).toBe('macro');
    expect(complete).toHaveBeenCalledTimes(2);
    const firstMessages = complete.mock.calls[0]![0].messages;
    const secondMessages = complete.mock.calls[1]![0].messages;
    // 第二次预算缩到 0.8，保留的历史更短；两次都是 系统段+历史+尾部指令 结构。
    expect(secondMessages.length).toBeLessThan(firstMessages.length);
    expect(String(secondMessages.at(-1)?.content)).toContain('未纳入');
  });

  it('Macro 成功后的近期历史不包含孤立 Tool Result', async () => {
    const complete = vi.fn(async () => completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
      keepRecentToolResults: 32,
    });

    const result = await compact(request(readHistory(10, 30), { force: true }));
    const toolUses = new Set<string>();
    for (const message of result.history) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (message.role === 'assistant' && block.type === 'tool_use') {
          toolUses.add(block.id);
        }
        if (message.role === 'user' && block.type === 'tool_result') {
          expect(toolUses.has(block.toolCallId)).toBe(true);
        }
      }
    }
  });

  it('最终预算无法容纳摘要时返回原历史并发送失败事件', async () => {
    const complete = vi.fn(async () => completion('summary '.repeat(100)));
    const history = textHistory();
    const compact = createCompact(llmCompleting(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
    });

    const events: CompactEvent[] = [];
    const result = await compact(request(history, {
      force: true,
      contextWindow: 4_000,
      estimatedInputTokens: estimateMessagesTokens(history) + 3_990,
      onEvent: (event) => events.push(event),
    }));

    expect(result).toEqual({ kind: 'unchanged', history });
    expect(events.at(-1)).toMatchObject({
      type: 'compact_failed',
      error: expect.stringContaining('历史预算'),
    });
  });

  it('saveMacroSummary 保存成功后才发 compact_completed', async () => {
    const complete = vi.fn(async () => completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
    });
    const events: CompactEvent[] = [];
    const saved: Array<{ summary: string; count: number }> = [];

    const result = await compact(request(textHistory(), {
      force: true,
      onEvent: (event) => events.push(event),
      saveMacroSummary: (summary, count) => { saved.push({ summary, count }); },
    }));

    expect(result).toMatchObject({ kind: 'macro' });
    if (result.kind !== 'macro') throw new Error('应为 macro');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({
      summary: '压缩后的工作摘要',
      count: result.summarizedMessageCount,
    });
    expect(events.map((event) => event.type)).toEqual([
      'compact_started',
      'compact_completed',
    ]);
  });

  it('saveMacroSummary 抛错：发 compact_failed、不发 completed、原错误上抛', async () => {
    const complete = vi.fn(async () => completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
    });
    const events: CompactEvent[] = [];

    await expect(compact(request(textHistory(), {
      force: true,
      onEvent: (event) => events.push(event),
      saveMacroSummary: () => { throw new Error('db down'); },
    }))).rejects.toThrow('db down');

    expect(events.map((event) => event.type)).toEqual([
      'compact_started',
      'compact_failed',
    ]);
  });

  it('拒绝把 System Prompt 混入可压缩历史', async () => {
    const compact = createCompact(llmCompleting(async () => completion()));
    await expect(compact(request([
      { role: 'system', content: 'stable product rules' },
    ]))).rejects.toThrow('不能包含 System Prompt');
  });
});
