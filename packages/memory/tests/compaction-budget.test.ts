// 测试 Compaction 不回放 Thinking，并且只有满足硬 Token 预算的摘要才能完成压缩。

import { describe, expect, it, vi } from 'vitest';
import type { SessionId, TurnId } from '@ema-agent/contracts';
import type { LlmMessage, LlmRequest } from '@ema-agent/llm';
import { estimateMessagesTokens } from '@ema-agent/token';
import { fitCompactionContext } from '../src/compact/budget.js';
import { runCompaction } from '../src/compact/compactor.js';
import { runMacroCompaction } from '../src/compact/macro.js';
import { sanitizeCompactionMessages } from '../src/compact/sanitize.js';
import { DEFAULT_OVERRIDES } from '../src/maintenance/overrides.js';
import { DEFAULT_MEMORY_SETTINGS } from '../src/types.js';

const sessionId = 'session-compaction-budget' as SessionId;
const turnId = 'turn-compaction-budget' as TurnId;

describe('Compaction Thinking 隔离', () => {
  it('删除 Assistant Thinking，同时保留同一条消息中的可回放 Block', () => {
    const messages: LlmMessage[] = [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'provider-private-reasoning' },
        { type: 'text', text: '可以回放的回答' },
      ],
    }];

    expect(sanitizeCompactionMessages(messages)).toEqual([{
      role: 'assistant',
      content: [{ type: 'text', text: '可以回放的回答' }],
    }]);
  });

  it('即使 Memory 被关闭，返回给 LLM 的消息也不包含 Thinking', async () => {
    const result = await runCompaction(
      {} as never,
      { ...DEFAULT_MEMORY_SETTINGS, enabled: false },
      () => DEFAULT_OVERRIDES,
      {
        sessionId,
        turnId,
        mode: 'chat',
        messages: [{
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '不得跨请求回放' },
            { type: 'text', text: '用户可见回答' },
          ],
        }],
        modelContextWindow: 8_000,
      },
    );

    expect(result.status).toBe('not_needed');
    expect(result.messages).toEqual([{
      role: 'assistant',
      content: [{ type: 'text', text: '用户可见回答' }],
    }]);
  });

  it('Macro 摘要提示词不会包含 Provider 私有 Thinking', async () => {
    let capturedRequest: LlmRequest | undefined;
    const complete = vi.fn(async (request: LlmRequest) => {
      capturedRequest = request;
      return {
        blocks: [{ type: 'text' as const, text: '安全摘要' }],
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 10, outputTokens: 2 },
      };
    });

    const result = await runMacroCompaction({
      llm: { complete } as never,
      providerId: 'provider-1',
      model: 'model-1',
      mode: 'agent',
      modelContextWindow: 8_000,
      toCompact: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'SECRET_REASONING_SENTINEL' },
          { type: 'text', text: '公开结论' },
        ],
      }],
    });

    expect(result.succeeded).toBe(true);
    expect(JSON.stringify(capturedRequest?.messages)).not.toContain('SECRET_REASONING_SENTINEL');
    expect(JSON.stringify(capturedRequest?.messages)).toContain('公开结论');
  });
});

describe('Compaction 硬 Token 预算', () => {
  it('优先丢弃恢复内容，再按 Unicode 字符边界截断超长摘要', () => {
    const tail: LlmMessage[] = [{ role: 'user', content: '近期消息 '.repeat(20) }];
    const fitted = fitCompactionContext({
      summary: '旧对话摘要🙂'.repeat(2_000),
      restore: [{ role: 'user', content: '可重新读取的文件内容 '.repeat(1_000) }],
      tail,
      mode: 'agent',
      tokenLimit: 300,
    });

    expect(fitted).not.toBeNull();
    expect(fitted?.restoreDropped).toBe(true);
    expect(fitted?.summaryTruncated).toBe(true);
    expect(fitted?.summary).toContain('[摘要已按当前模型上下文预算截断]');
    expect(fitted?.afterTokens).toBeLessThanOrEqual(300);
    expect(estimateMessagesTokens(fitted?.messages ?? [])).toBeLessThanOrEqual(300);
  });

  it('近期消息自身已耗尽预算时明确失败，不伪装成压缩完成', () => {
    const fitted = fitCompactionContext({
      summary: '很短的摘要',
      restore: [],
      tail: [{ role: 'user', content: '无法删除的近期消息 '.repeat(2_000) }],
      mode: 'chat',
      tokenLimit: 100,
    });

    expect(fitted).toBeNull();
  });

  it('只有收敛后的摘要会落盘，并以真实 Token 数报告完成', async () => {
    const appendMessage = vi.fn();
    const complete = vi.fn(async () => ({
      blocks: [{ type: 'text' as const, text: '模型返回的超长摘要 '.repeat(5_000) }],
      stopReason: 'end_turn' as const,
      usage: { inputTokens: 100, outputTokens: 5_000 },
    }));
    const messages: LlmMessage[] = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `message-${index} ${'long context '.repeat(50)}`,
    }));

    const result = await runCompaction(
      {
        session: { appendMessage },
        llm: {
          complete,
          firstProviderId: () => 'provider-1',
          defaultModelFor: () => 'model-1',
        },
      } as never,
      {
        ...DEFAULT_MEMORY_SETTINGS,
        compaction: { bufferTokens: 2_000 },
      },
      () => DEFAULT_OVERRIDES,
      {
        sessionId,
        turnId,
        mode: 'agent',
        messages,
        modelContextWindow: 4_000,
      },
    );

    expect(result.status).toBe('completed');
    expect(result.afterTokens).toBeLessThanOrEqual(2_000);
    expect(estimateMessagesTokens(result.messages)).toBe(result.afterTokens);
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      turnId,
      kind: 'summary',
      blocks: expect.stringContaining('[摘要已按当前模型上下文预算截断]'),
    }));
  });

  it('不可删除的近期消息超过预算时不写入无效摘要', async () => {
    const appendMessage = vi.fn();
    const complete = vi.fn(async () => ({
      blocks: [{ type: 'text' as const, text: '很短的摘要' }],
      stopReason: 'end_turn' as const,
      usage: { inputTokens: 100, outputTokens: 10 },
    }));
    const messages: LlmMessage[] = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: index < 12
        ? `old-${index} ${'history '.repeat(20)}`
        : `recent-${index} ${'must remain '.repeat(500)}`,
    }));

    const result = await runCompaction(
      {
        session: { appendMessage },
        llm: {
          complete,
          firstProviderId: () => 'provider-1',
          defaultModelFor: () => 'model-1',
        },
      } as never,
      {
        ...DEFAULT_MEMORY_SETTINGS,
        compaction: { bufferTokens: 2_000 },
      },
      () => DEFAULT_OVERRIDES,
      {
        sessionId,
        turnId,
        mode: 'agent',
        messages,
        modelContextWindow: 4_000,
      },
    );

    expect(result).toEqual(expect.objectContaining({
      status: 'failed',
      reason: 'macro_failed',
      detail: 'Compacted context still exceeds hard token limit 2000',
    }));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(appendMessage).not.toHaveBeenCalled();
  });
});
