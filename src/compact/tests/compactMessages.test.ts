// 验证 Compact 的提交时机, 响应式恢复, 取消, 熔断和 Tool 配对边界.

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
import { buildCompactPrompt } from '../compactPrompt.js';
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
    yield { type: 'usage' as const, ...result.usage };
    yield { type: 'done' as const, stopReason: result.stopReason };
  })();
}

function request(messages: readonly Message[], overrides: Partial<CompactRequest> = {}): CompactRequest {
  return {
    sessionId,

    sessionMode: 'work' as const,
    messages,
    systemMessages: [{ role: 'system', content: '产品系统提示' }],
    tools: [],
    estimatedInputTokens: estimateMessagesTokens([...messages]),
    contextWindow: 4_000,
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

describe('buildCompactPrompt', () => {
  it('Chat 与 Work 使用同一套交接结构，只改变摘要侧重点', () => {
    const chat = buildCompactPrompt({ sessionMode: 'chat' });
    const work = buildCompactPrompt({ sessionMode: 'work' });
    const sharedHeadings = [
      '## Current Objective and State',
      '## Active Instructions and Corrections',
      '## Confirmed Decisions',
      '## Relevant Context and Evidence',
      '## Completed Work',
      '## Open Work and Unknowns',
      '## Interaction Context',
      '## Continuation Point',
    ];

    for (const heading of sharedHeadings) {
      expect(chat).toContain(heading);
      expect(work).toContain(heading);
    }
    expect(chat).toContain('chat mode');
    expect(work).toContain('work mode');
    expect(chat).toContain('mode changes emphasis only');
    expect(work).toContain('mode changes emphasis only');
  });

  it('角色人设只帮助理解历史，不复制进摘要', () => {
    const prompt = buildCompactPrompt({ sessionMode: 'chat' });

    expect(prompt).toContain('Use the current character persona to understand');
    expect(prompt).toContain('do not copy or rewrite the persona');
    expect(prompt).toContain('next turn receives those authoritative System messages again');
  });

  it('保留最新有效约束并区分证据、提议与猜测', () => {
    const prompt = buildCompactPrompt({ sessionMode: 'work' });

    expect(prompt).toContain('Newer user instructions override older ones');
    expect(prompt).toContain('Do not promote an assistant proposal');
    expect(prompt).toContain('Distinguish tool-verified evidence');
    expect(prompt).not.toContain('verbatim quotes of every user message');
  });
});

describe('createCompact', () => {
  it('低于阈值时原样返回历史且不调用模型', async () => {
    const complete = vi.fn(async (_request: LlmRequest) => completion());
    const history: Message[] = [{ role: 'user', content: 'short' }];
    const compact = createCompact(llmCompleting(complete), {
      bufferRatio: 0,
    });

    const result = await compact(request(history, { contextWindow: 100_000 }));

    expect(result).toEqual({ kind: 'unchanged', messages: history });
    expect(complete).not.toHaveBeenCalled();
  });

  it('强制压缩短历史时仍总结至少一条完整消息', async () => {
    const complete = vi.fn(async (_request: LlmRequest) => completion());
    const messages: Message[] = [{ role: 'user', content: 'short' }];
    const compact = createCompact(llmCompleting(complete), { bufferRatio: 0 });

    const result = await compact(request(messages, {
      force: true,
      contextWindow: 100_000,
    }));

    expect(result.kind).toBe('macro');
    if (result.kind !== 'macro') throw new Error('应为 macro');
    expect(result.summarizedMessageCount).toBe(1);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('Micro 足以恢复预算时直接返回清理后的历史', async () => {
    const complete = vi.fn(async () => completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferRatio: 0,
      keepRecentToolResults: 1,
    });

    const result = await compact(request(readHistory(), { contextWindow: 1_500 }));

    expect(result.kind).toBe('micro');
    expect(JSON.stringify(result.messages).match(/Old tool result content cleared/gu)).toHaveLength(7);
    expect(estimateMessagesTokens([...result.messages])).toBeLessThan(estimateMessagesTokens(readHistory()));
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

    const result = microCompact(history, { keepRecentToolResults: 1 });
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
      bufferRatio: 0,
      keepRecentToolResults: 1,
    });

    const events: CompactEvent[] = [];
    const result = await compact(request(history, {
      force: true,
      emit: (event) => events.push(event),
    }));

    expect(result).toMatchObject({
      kind: 'unchanged',
      messages: history,
      failureDetail: 'provider unavailable',
    });
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
      bufferRatio: 0,
      maximumConsecutiveFailures: 1,
    });

    await expect(compact(request(textHistory(), {
      force: true,
      signal: controller.signal,
      emit: (event) => events.push(event),
    }))).rejects.toMatchObject({ name: 'AbortError' });

    expect(events.map((event) => event.type)).toEqual([
      'compact_started',
      'compact_cancelled',
    ]);
    const success = await compact(request(textHistory(), { force: true }));
    expect(JSON.stringify(success)).toContain('压缩后的工作摘要');
    expect(complete.mock.calls.length).toBeGreaterThan(1);
  });

  it('响应式压缩绕过自动关闭和连续失败熔断', async () => {
    const events: CompactEvent[] = [];
    const complete = vi.fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValue(completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferRatio: 0,
      maximumConsecutiveFailures: 1,
    });

    const history = textHistory();
    expect(await compact(request(history, {
      emit: (event) => events.push(event),
    }))).toMatchObject({
      kind: 'unchanged',
      messages: history,
      failureDetail: 'provider unavailable',
    });
    expect(events.at(-1)?.type).toBe('compact_failed');
    expect(await compact(request(history))).toEqual({ kind: 'unchanged', messages: history });
    expect(complete).toHaveBeenCalledTimes(1);
    const forced = await compact(request(textHistory(), {
      force: true,
      settings: {
        bufferRatio: 0,
        outputTokens: 8_000,
        keepRecentToolResults: 6,
        maximumConsecutiveFailures: 1,
        retainRatio: 0.16,
      },
    }));
    expect(JSON.stringify(forced)).toContain('压缩后的工作摘要');
    expect(complete.mock.calls.length).toBeGreaterThan(1);
  });

  it('单条消息超过摘要请求预算时失败, 不跳过该消息', async () => {
    const complete = vi.fn(async (_request: LlmRequest) => completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferRatio: 0,
    });
    const history: Message[] = [{ role: 'user', content: 'huge '.repeat(20_000) }];

    const result = await compact(request(history, {
      force: true,
      contextWindow: 4_000,
    }));

    expect(result).toMatchObject({
      kind: 'unchanged',
      messages: history,
      failureDetail: expect.stringContaining('超过摘要请求预算'),
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it('近期尾部二分切点选预算内最左起点', async () => {
    const complete = vi.fn(async (_request: LlmRequest) => completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferRatio: 0.15,
      retainRatio: 0.05,
    });
    const messages = textHistory(12, 30);
    const tailBudget = Math.floor(4_000 * 0.05);
    let expectedStart = messages.length - 1;
    for (let index = 0; index < messages.length; index += 1) {
      if (estimateMessagesTokens(messages.slice(index)) <= tailBudget) {
        expectedStart = index;
        break;
      }
    }

    const result = await compact(request(messages, { force: true }));

    expect(result.kind).toBe('macro');
    if (result.kind !== 'macro') throw new Error('应为 macro');
    expect(expectedStart).toBeGreaterThan(1);
    expect(result.summarizedMessageCount).toBe(expectedStart);
    expect(result.messages.slice(1)).toEqual(messages.slice(expectedStart));
  });

  it('摘要分段二分切点选预算内最远终点', async () => {
    const complete = vi.fn(async (_request: LlmRequest) => completion());
    const compact = createCompact(llmCompleting(complete), { bufferRatio: 0.15 });
    const messages = textHistory(20, 80);

    const result = await compact(request(messages, { force: true }));

    expect(result.kind).toBe('macro');
    if (result.kind !== 'macro') throw new Error('应为 macro');
    const firstCall = complete.mock.calls[0]![0];
    const firstChunk = firstCall.messages.slice(1, -1);
    const fixedInput: Message[] = [
      { role: 'system', content: '产品系统提示' },
      { role: 'user', content: buildCompactPrompt({ sessionMode: 'work' }) },
    ];
    const chunkBudget = Math.floor(4_000 * 0.85) - estimateMessagesTokens(fixedInput);
    let expectedEnd = 0;
    for (let end = 1; end <= result.summarizedMessageCount; end += 1) {
      if (estimateMessagesTokens(messages.slice(0, end)) > chunkBudget) break;
      expectedEnd = end;
    }

    expect(expectedEnd).toBeGreaterThan(1);
    expect(expectedEnd).toBeLessThan(result.summarizedMessageCount);
    expect(firstChunk).toEqual(messages.slice(0, expectedEnd));
  });

  it('摘要请求透传根 Turn 冻结的 tools 与 thinking 配置', async () => {
    const complete = vi.fn(async (_request: LlmRequest) => completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferRatio: 0,
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
      bufferRatio: 0,
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

  it('摘要模型判超时缩短当前分段, 后续仍覆盖全部原消息', async () => {
    const complete = vi.fn()
      .mockRejectedValueOnce(new Error('prompt is too long for this model'))
      .mockResolvedValue(completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferRatio: 0,
    });

    const result = await compact(request(textHistory(), { force: true }));

    expect(result.kind).toBe('macro');
    expect(complete.mock.calls.length).toBeGreaterThan(2);
    const firstMessages = complete.mock.calls[0]![0].messages;
    const secondMessages = complete.mock.calls[1]![0].messages;
    // 重试只缩小当前分段, 已移出的消息会进入后续分段.
    expect(secondMessages.length).toBeLessThan(firstMessages.length);
    expect(String(secondMessages.at(-1)?.content)).toContain('compacting messages');
    expect(JSON.stringify(complete.mock.calls)).not.toContain('未纳入');
  });

  it('摘要输出被 max_tokens 截断时不把半篇摘要当成已完成', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({
        ...completion('<summary>只有半篇'),
        stopReason: 'max_tokens',
      })
      .mockResolvedValue(completion());
    const compact = createCompact(llmCompleting(complete), { bufferRatio: 0.15 });

    const result = await compact(request(textHistory(), { force: true }));

    expect(result.kind).toBe('macro');
    expect(complete.mock.calls.length).toBeGreaterThan(1);
    expect(JSON.stringify(result.messages)).not.toContain('只有半篇');
  });

  it('Macro 分段和近期原文都不拆开 Tool Use 与 Tool Result', async () => {
    const complete = vi.fn(async (_request: LlmRequest) => completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferRatio: 0,
      keepRecentToolResults: 32,
    });

    const result = await compact(request(readHistory(20, 80), { force: true }));
    expect(complete.mock.calls.length).toBeGreaterThan(1);
    for (const [sent] of complete.mock.calls) {
      const uses = new Set<string>();
      const results = new Set<string>();
      for (const message of sent.messages) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
          if (message.role === 'assistant' && block.type === 'tool_use') uses.add(block.id);
          if (message.role === 'user' && block.type === 'tool_result') results.add(block.toolCallId);
        }
      }
      expect(results).toEqual(uses);
    }
    const toolUses = new Set<string>();
    for (const message of result.messages) {
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
      bufferRatio: 0,
    });

    const events: CompactEvent[] = [];
    const result = await compact(request(history, {
      force: true,
      contextWindow: 4_000,
      estimatedInputTokens: estimateMessagesTokens(history) + 3_990,
      emit: (event) => events.push(event),
    }));

    expect(result).toMatchObject({
      kind: 'unchanged',
      messages: history,
      failureDetail: expect.stringContaining('占满预算'),
    });
    expect(events.at(-1)).toMatchObject({
      type: 'compact_failed',
      error: expect.stringContaining('占满预算'),
    });
  });

  it('模型返回超预算摘要时失败, 不截断摘要正文后保存', async () => {
    const complete = vi.fn(async () => completion(`<summary>${'fact '.repeat(10_000)}</summary>`));
    const compact = createCompact(llmCompleting(complete), { bufferRatio: 0.15 });
    const messages = textHistory(10, 40);
    const saveMacroSummary = vi.fn();

    const result = await compact(request(messages, {
      force: true,
      saveMacroSummary,
    }));

    expect(result).toMatchObject({
      kind: 'unchanged',
      messages,
      failureDetail: expect.stringContaining('无法放入'),
    });
    expect(saveMacroSummary).not.toHaveBeenCalled();
  });

  it('超窗口时逐段覆盖全部旧消息, 汇总每次摘要调用用量', async () => {
    const complete = vi.fn(async (_request: LlmRequest) => completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferRatio: 0.15,
    });
    const events: CompactEvent[] = [];
    const history = textHistory();

    const result = await compact(request(history, {
      force: true,
      emit: (event) => events.push(event),
    }));

    if (result.kind !== 'macro') throw new Error('应为 macro');
    expect(complete.mock.calls.length).toBeGreaterThan(1);
    expect(result.messages.slice(1)).toEqual(history.slice(result.summarizedMessageCount));
    const sent = JSON.stringify(complete.mock.calls.map(([call]) => call.messages));
    for (let index = 0; index < result.summarizedMessageCount; index += 1) {
      const marker = index % 2 === 0 ? `user-${index} ` : `assistant-${index} `;
      expect(sent.split(marker)).toHaveLength(2);
    }
    expect(complete.mock.calls.slice(1).some(([call]) =>
      call.messages.some(message => String(message.content).includes('<context-summary'))
    )).toBe(true);
    expect(result.usage).toEqual({
      inputTokens: complete.mock.calls.length * 100,
      outputTokens: complete.mock.calls.length * 20,
    });
    expect(events.map(event => event.type)).toEqual(['compact_started', 'compact_completed']);
  });

  it('后一段摘要失败时不保存前一段的半成品', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(completion())
      .mockRejectedValue(new Error('provider unavailable'));
    const compact = createCompact(llmCompleting(complete), { bufferRatio: 0.15 });
    const history = textHistory(40);
    const events: CompactEvent[] = [];
    const saveMacroSummary = vi.fn();

    const result = await compact(request(history, {
      force: true,
      emit: event => events.push(event),
      saveMacroSummary,
    }));

    expect(complete.mock.calls.length).toBeGreaterThan(1);
    expect(result).toMatchObject({
      kind: 'unchanged',
      messages: history,
      failureDetail: 'provider unavailable',
    });
    expect(saveMacroSummary).not.toHaveBeenCalled();
    expect(events.map(event => event.type)).toEqual(['compact_started', 'compact_failed']);
  });

  it('saveMacroSummary 保存成功后才发 compact_completed', async () => {
    const complete = vi.fn(async () => completion());
    const compact = createCompact(llmCompleting(complete), {
      bufferRatio: 0,
    });
    const events: CompactEvent[] = [];
    const saved: Array<{ summary: string; count: number }> = [];

    const result = await compact(request(textHistory(), {
      force: true,
      emit: (event) => events.push(event),
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
      bufferRatio: 0,
    });
    const events: CompactEvent[] = [];

    await expect(compact(request(textHistory(), {
      force: true,
      emit: (event) => events.push(event),
      saveMacroSummary: () => { throw new Error('db down'); },
    }))).rejects.toThrow('db down');

    // 保存失败时不得宣称 Compact 已完成.
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
