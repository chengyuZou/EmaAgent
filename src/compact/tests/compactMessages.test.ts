// 验证 Compact 的提交原子性、响应式恢复、取消、熔断和 Tool 配对边界。

import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import type {
  LanguageModel,
  LlmCompletion,
  LlmRequest,
  Message,
} from '@ema-agent/llm';
import { estimateMessagesTokens } from '@ema-agent/token';
import type { CompactEvent } from '../events.js';
import { CompactMessages } from '../compactMessages.js';
import { microCompact } from '../microCompact.js';

const sessionId = asSessionId('compact-session');
const turnId = asTurnId('compact-turn');

function completion(text = '<summary>压缩后的工作摘要</summary>'): LlmCompletion {
  return {
    blocks: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 100, outputTokens: 20 },
  };
}

function languageModel(complete: (request: LlmRequest) => Promise<LlmCompletion>): LanguageModel {
  return { complete, stream: vi.fn() as never };
}

function request(history: readonly Message[], overrides: Partial<Parameters<CompactMessages['compact']>[0]> = {}) {
  return {
    sessionId,
    turnId,
    executionProfile: 'work' as const,
    history,
    estimatedInputTokens: estimateMessagesTokens([...history]),
    contextWindow: 4_000,
    maxOutputTokens: 0,
    providerId: 'provider-1',
    model: 'model-1',
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

describe('CompactMessages', () => {
  it('低于阈值时原样返回历史且不调用模型', async () => {
    const complete = vi.fn(async (_request: LlmRequest) => completion());
    const history: Message[] = [{ role: 'user', content: 'short' }];
    const compact = new CompactMessages(languageModel(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
    });

    const result = await compact.compact(request(history, { contextWindow: 100_000 }));

    expect(result).toMatchObject({ status: 'not_needed', reason: 'below_threshold' });
    expect(result.history).toEqual(history);
    expect(complete).not.toHaveBeenCalled();
  });

  it('Micro 足以恢复预算时明确提交为 completed', async () => {
    const complete = vi.fn(async () => completion());
    const compact = new CompactMessages(languageModel(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
      keepRecentToolResults: 1,
    });

    const result = await compact.compact(request(readHistory(), { contextWindow: 1_500 }));

    expect(result).toMatchObject({ status: 'completed', method: 'micro' });
    expect(result.microCleared).toBe(7);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
    expect(complete).not.toHaveBeenCalled();
  });

  it('Micro 保留原 Tool Result 的错误事实', () => {
    const history = readHistory(3, 10);
    const firstResult = history[1]!;
    if (firstResult.role !== 'user' || typeof firstResult.content === 'string') {
      throw new Error('测试夹具不是 Tool Result');
    }
    firstResult.content[0] = {
      type: 'tool_result',
      toolCallId: 'read-0',
      content: 'read failed',
      isError: true,
    };

    const result = microCompact(history, { keepRecent: 1 });
    const cleared = result.messages[1]!;
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
    const compact = new CompactMessages(languageModel(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
      keepRecentToolResults: 1,
    });

    const result = await compact.compact(request(history, { force: true }));

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'macro_failed',
      microCleared: 0,
      savedTokens: 0,
    });
    expect(result.history).toEqual(history);
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
    const compact = new CompactMessages(languageModel(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
      maximumConsecutiveFailures: 1,
    });

    await expect(compact.compact(request(textHistory(), {
      force: true,
      signal: controller.signal,
      emit: (event) => events.push(event),
    }))).rejects.toMatchObject({ name: 'AbortError' });

    expect(events.map((event) => event.type)).toEqual([
      'compact_started',
      'compact_cancelled',
    ]);
    const success = await compact.compact(request(textHistory(), { force: true }));
    expect(success.status).toBe('completed');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('响应式压缩绕过自动关闭和连续失败熔断', async () => {
    const complete = vi.fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValue(completion());
    const compact = new CompactMessages(languageModel(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
      maximumConsecutiveFailures: 1,
    });

    expect((await compact.compact(request(textHistory()))).status).toBe('failed');
    expect((await compact.compact(request(textHistory()))).status).toBe('skipped');
    const forced = await compact.compact(request(textHistory(), {
      force: true,
      settings: {
        enabled: false,
        bufferTokens: 0,
        defaultReservedOutputTokens: 0,
        maximumReservedOutputTokens: 0,
        keepRecentToolResults: 6,
        maximumConsecutiveFailures: 1,
      },
    }));
    expect(forced).toMatchObject({ status: 'completed', method: 'macro' });
  });

  it('单条超大历史也会进入 Macro，而不是误判为历史不足', async () => {
    const complete = vi.fn(async (_request: LlmRequest) => completion());
    const compact = new CompactMessages(languageModel(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
    });
    const history: Message[] = [{ role: 'user', content: 'huge '.repeat(20_000) }];

    const result = await compact.compact(request(history, {
      force: true,
      contextWindow: 4_000,
    }));

    expect(result).toMatchObject({ status: 'completed', method: 'macro' });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(String(complete.mock.calls[0]?.[0]?.messages[0]?.content))
      .toContain('部分历史因摘要模型输入上限被省略');
  });

  it('Macro 成功后的近期历史不包含孤立 Tool Result', async () => {
    const complete = vi.fn(async () => completion());
    const compact = new CompactMessages(languageModel(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
      keepRecentToolResults: 32,
    });

    const result = await compact.compact(request(readHistory(10, 30), { force: true }));
    expect(result.status).toBe('completed');
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

  it('最终预算无法容纳摘要时返回原历史并标记 budget_exceeded', async () => {
    const complete = vi.fn(async () => completion('summary '.repeat(100)));
    const history = textHistory();
    const compact = new CompactMessages(languageModel(complete), {
      bufferTokens: 0,
      defaultReservedOutputTokens: 0,
      maximumReservedOutputTokens: 0,
    });

    const result = await compact.compact(request(history, {
      force: true,
      contextWindow: 4_000,
      estimatedInputTokens: estimateMessagesTokens(history) + 3_990,
    }));

    expect(result).toMatchObject({ status: 'failed', reason: 'budget_exceeded' });
    expect(result.history).toEqual(history);
  });

  it('拒绝把 System Prompt 混入可压缩历史', async () => {
    const compact = new CompactMessages(languageModel(async () => completion()));
    await expect(compact.compact(request([
      { role: 'system', content: 'stable product rules' },
    ]))).rejects.toThrow('不能包含 System Prompt');
  });
});
