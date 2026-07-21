// 测试 Context 压缩的阈值、摘要持久化与连续失败熔断。
import {
  describe,
  expect,
  it,
  vi } from 'vitest';
import { asSessionId,
  asTurnId,
} from '@ema-agent/contracts';
import {
  type EmaStreamEvent,
} from '@ema-agent/turn';
import type { LlmRequest, Message } from '@ema-agent/llm';
import { ContextCompactor } from '../contextCompactor.js';

const sessionId = asSessionId('context-session');
const turnId = asTurnId('context-turn');

function oversizedHistory(): Message[] {
  return Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `message-${index} ${'long context '.repeat(50)}`,
  }));
}

function args(messages: Message[]) {
  return {
    sessionId,
    turnId,
    mode: 'agent' as const,
    messages,
    modelContextWindow: 4_000,
    modelMaxOutputTokens: 0,
    providerId: 'provider-1',
    model: 'model-1',
  };
}

describe('ContextCompactor', () => {
  it('低于阈值时不修改历史，也不调用压缩模型', async () => {
    const complete = vi.fn();
    const persistSummary = vi.fn();
    const compactor = new ContextCompactor(
      { llm: { complete } as never, persistSummary },
      { bufferTokens: 2_000, defaultReservedOutputTokens: 0, maximumReservedOutputTokens: 0 },
    );
    const messages: Message[] = [{ role: 'user', content: 'short message' }];

    const result = await compactor.compact(args(messages));

    expect(result).toEqual(expect.objectContaining({ status: 'not_needed', reason: 'below_threshold' }));
    expect(result.messages).toEqual(messages);
    expect(complete).not.toHaveBeenCalled();
    expect(persistSummary).not.toHaveBeenCalled();
  });

  it('只有满足硬预算的摘要才持久化，并发送 Context 事件', async () => {
    const events: EmaStreamEvent[] = [];
    const persistSummary = vi.fn();
    const complete = vi.fn(async (_request: LlmRequest) => ({
      blocks: [{ type: 'text' as const, text: '压缩后的工作摘要' }],
      stopReason: 'end_turn' as const,
      usage: { inputTokens: 100, outputTokens: 10 },
    }));
    const compactor = new ContextCompactor(
      { llm: { complete } as never, persistSummary },
      { bufferTokens: 2_000, defaultReservedOutputTokens: 0, maximumReservedOutputTokens: 0 },
    );

    const result = await compactor.compact({ ...args(oversizedHistory()), emit: event => events.push(event) });

    expect(result.status).toBe('completed');
    expect(result.afterTokens).toBeLessThanOrEqual(2_000);
    expect(persistSummary).toHaveBeenCalledTimes(1);
    expect(events.map(event => event.type)).toEqual([
      'context_compaction_started',
      'context_compaction_completed',
    ]);
  });

  it('响应式压缩始终原样保留 System Prompt，且不把它交给摘要模型', async () => {
    const complete = vi.fn(async (request: LlmRequest) => ({
      blocks: [{ type: 'text' as const, text: '压缩后的工作摘要' }],
      stopReason: 'end_turn' as const,
      usage: { inputTokens: 100, outputTokens: 10 },
      request,
    }));
    const compactor = new ContextCompactor(
      { llm: { complete } as never, persistSummary: vi.fn() },
      { bufferTokens: 2_000, defaultReservedOutputTokens: 0, maximumReservedOutputTokens: 0 },
    );
    const system = {
      role: 'system' as const,
      content: '产品安全规则不得被压缩',
      cacheBreakpoint: true as const,
    };

    const result = await compactor.compact(args([system, ...oversizedHistory()]));

    expect(result.status).toBe('completed');
    expect(result.messages[0]).toEqual(system);
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0]?.[0];
    expect(request?.messages[0]?.content).not.toContain(system.content);
  });

  it('固定前缀和尾部参与预算但不进入摘要，并在压缩后原样保留', async () => {
    const complete = vi.fn(async (_request: LlmRequest) => ({
      blocks: [{ type: 'text' as const, text: '压缩后的工作摘要' }],
      stopReason: 'end_turn' as const,
      usage: { inputTokens: 100, outputTokens: 10 },
    }));
    const compactor = new ContextCompactor(
      { llm: { complete } as never, persistSummary: vi.fn() },
      { bufferTokens: 2_000, defaultReservedOutputTokens: 0, maximumReservedOutputTokens: 0 },
    );
    const prefix: Message[] = [{ role: 'system', content: '固定产品规则' }];
    const suffix: Message[] = [
      { role: 'user', content: '<memory>本轮临时召回</memory>' },
      { role: 'user', content: '当前用户问题' },
    ];

    const result = await compactor.compact({
      ...args(oversizedHistory()),
      prefixMessages: prefix,
      suffixMessages: suffix,
    });

    expect(result.status).toBe('completed');
    expect(result.messages[0]).toEqual(prefix[0]);
    expect(result.messages.slice(-2)).toEqual(suffix);
    const summaryRequest = complete.mock.calls[0]?.[0];
    const summaryInput = JSON.stringify(summaryRequest?.messages);
    expect(summaryInput).not.toContain('固定产品规则');
    expect(summaryInput).not.toContain('本轮临时召回');
    expect(summaryInput).not.toContain('当前用户问题');
  });

  it('连续失败达到上限后打开熔断器，不再消耗模型调用', async () => {
    const complete = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const compactor = new ContextCompactor(
      { llm: { complete } as never, persistSummary: vi.fn() },
      {
        bufferTokens: 2_000,
        defaultReservedOutputTokens: 0,
        maximumReservedOutputTokens: 0,
        maximumConsecutiveFailures: 2,
      },
    );

    const first = await compactor.compact(args(oversizedHistory()));
    const second = await compactor.compact(args(oversizedHistory()));
    const third = await compactor.compact(args(oversizedHistory()));

    expect(first.status).toBe('failed');
    expect(second.status).toBe('failed');
    expect(third).toEqual(expect.objectContaining({ status: 'skipped', reason: 'circuit_open' }));
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
