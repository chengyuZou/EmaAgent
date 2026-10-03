// 验证 fork 固定前缀交接, 当前 Assistant 的落库边界和等待取消.
import { describe, expect, it, vi } from 'vitest';
import type { LlmGenerationSource } from '@ema-agent/llm';
import type { SessionMessage } from '@ema-agent/session';
import { createForkParentMessages } from '../forkParentMessages.js';

const source: LlmGenerationSource = { providerId: 'p', modelId: 'm', protocol: 'openai-llm' };

function storedMessage(id: string, blocks: SessionMessage['blocks']): SessionMessage {
  return {
    id, sessionId: 'session', turnId: 'turn', role: 'user', kind: 'normal',
    blocks, interrupted: false, createdAt: 1, summarizedThroughMessageId: null,
  };
}

function fixture(messages: SessionMessage[]) {
  const rows = new Map(messages.map(message => [message.id, message]));
  const getMessage = vi.fn((id: string): SessionMessage => rows.get(id)!);
  return { rows, getMessage, fork: createForkParentMessages({ getMessage }) };
}

describe('fork 父消息交接', () => {
  it('没有 fork 领取时, 请求开始、Assistant 完成及失败都不读取 SQL', async () => {
    const user = storedMessage('user', '任务');
    const assistant = { ...storedMessage('assistant', [{ type: 'text' as const, text: '回复' }]),
      role: 'assistant' as const };
    const { fork, getMessage } = fixture([user, assistant]);
    fork.beginRequest([{ role: 'user', content: '任务' }], ['user']);
    fork.completeAssistant('assistant', source);
    await Promise.resolve();
    fork.beginRequest([{ role: 'user', content: '任务' }], ['user']);
    fork.fail(new Error('父请求失败'));
    await Promise.resolve();
    expect(getMessage).not.toHaveBeenCalled();
  });

  it('首次领取等 Assistant 完成才构建, 同轮前后到达的兄弟 fork 只共用一次 SQL 读取', async () => {
    const user = storedMessage('user', '任务');
    const assistant = { ...storedMessage('assistant', [{ type: 'text' as const, text: '完整回复' }]),
      role: 'assistant' as const };
    const { fork, getMessage } = fixture([user, assistant]);
    fork.beginRequest([{ role: 'user', content: '任务' }], ['user']);
    const first = fork.read(new AbortController().signal);
    const sibling = fork.read(new AbortController().signal);
    await Promise.resolve();
    expect(getMessage).not.toHaveBeenCalled();
    fork.completeAssistant('assistant', source);
    // completeAssistant 只兑现身份, SQL 构建在领取者的 Promise 中执行.
    expect(getMessage).not.toHaveBeenCalled();
    const result = await first;
    expect(await sibling).toBe(result);
    expect(await fork.read(new AbortController().signal)).toBe(result);
    expect(getMessage.mock.calls).toEqual([['user'], ['assistant']]);
  });

  it('固定请求消息与 ID 数组, 后续追加或 Macro 改写数组不影响延迟构建', async () => {
    const user = storedMessage('user', '原请求');
    const next = storedMessage('next', '后续请求');
    const { fork, getMessage } = fixture([user, next]);
    const messages = [{ role: 'user' as const, content: '原请求' }];
    const messageIds: (string | undefined)[] = ['user'];
    fork.beginRequest(messages, messageIds);
    messages.splice(0, 1, { role: 'user', content: '后续请求' });
    messageIds.splice(0, 1, 'next');
    fork.completeAssistant(undefined, source);
    const result = await fork.read(new AbortController().signal);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ id: 'user', blocks: '原请求' });
    expect(getMessage.mock.calls).toEqual([['user']]);
  });

  it('父前缀 SQL 读取失败只尝试一次, 同轮等待者收到同一个错误', async () => {
    const { fork, getMessage } = fixture([]);
    const error = new Error('消息读取失败');
    getMessage.mockImplementation(() => { throw error; });
    fork.beginRequest([{ role: 'user', content: '任务' }], ['user']);
    const first = fork.read(new AbortController().signal);
    const sibling = fork.read(new AbortController().signal);
    const assertions = Promise.all([
      expect(first).rejects.toBe(error),
      expect(sibling).rejects.toBe(error),
    ]);
    fork.completeAssistant(undefined, source);
    await assertions;
    await expect(fork.read(new AbortController().signal)).rejects.toBe(error);
    expect(getMessage).toHaveBeenCalledTimes(1);
  });

  it('同轮等待者等完整 Assistant 落库后共用固定前缀, 后续请求不改写已经领取的前缀', async () => {
    const user = storedMessage('user', '任务一');
    const assistant = { ...storedMessage('assistant', [{ type: 'text' as const, text: '完整尾部' }]),
      role: 'assistant' as const };
    const { fork } = fixture([user, assistant]);
    fork.beginRequest([{ role: 'user', content: '任务一' }], ['user']);
    const first = fork.read(new AbortController().signal);
    const sibling = fork.read(new AbortController().signal);
    const delivered = vi.fn();
    void first.then(delivered);
    await Promise.resolve();
    expect(delivered).not.toHaveBeenCalled();

    fork.completeAssistant('assistant', source);
    fork.beginRequest([{ role: 'user', content: '任务二' }], [undefined]);
    fork.completeAssistant(undefined, source);
    const result = await first;
    expect(result).toBe(await sibling);
    expect(result.messages.map(message => message.id)).toEqual(['user', 'assistant']);
    expect(result.messages[1]).toMatchObject({ blocks: assistant.blocks, generatedBy: source });
    expect((await fork.read(new AbortController().signal)).messages[0]?.blocks).toBe('任务二');
  });

  it('取消一个子代理的等待不影响同轮其他等待者', async () => {
    const { fork } = fixture([]);
    fork.beginRequest([], []);
    const aborted = new AbortController();
    const cancelled = fork.read(aborted.signal);
    const sibling = fork.read(new AbortController().signal);
    const rejection = expect(cancelled).rejects.toBe('停止子代理');
    aborted.abort('停止子代理');
    await rejection;
    fork.completeAssistant(undefined, source);
    expect(await sibling).toEqual({ messages: [] });
    expect(() => fork.read(aborted.signal)).toThrow();
  });

  it('父请求失败释放等待者, 无等待者的失败也不产生未处理拒绝', async () => {
    const { fork } = fixture([]);
    fork.beginRequest([], []);
    const waiting = fork.read(new AbortController().signal);
    const failure = new Error('父消息保存失败');
    const rejection = expect(waiting).rejects.toBe(failure);
    fork.fail(failure);
    await rejection;
    fork.beginRequest([], []);
    fork.fail(failure);
    await Promise.resolve();
  });

  it('Micro 正文来自本次模型消息, data/耗时和摘要字段仍来自 SQL', async () => {
    const tool = { ...storedMessage('tool', [{
      type: 'tool_result' as const, toolCallId: 'read', content: '原始长输出',
      data: { value: '原始事实' }, durationMs: 9,
    }]), kind: 'tool_results' as const };
    const summary = { ...storedMessage('summary', '历史摘要'), kind: 'summary' as const,
      summarizedThroughMessageId: 'covered', savedTokens: 50 };
    const oldAssistant = { ...storedMessage('old-assistant', [{ type: 'text' as const, text: '历史回复' }]),
      role: 'assistant' as const };
    const { fork, rows } = fixture([tool, summary, oldAssistant]);
    fork.beginRequest([
      { role: 'system', content: '不属于工作历史' },
      { role: 'user', content: '历史摘要' },
      { role: 'assistant', content: [{ type: 'text', text: '历史回复' }], generatedBy: source },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'read', content: '[已压短]' }] },
      { role: 'user', content: '仅模型引导' },
    ], [undefined, 'summary', 'old-assistant', 'tool', undefined]);
    fork.completeAssistant(undefined, source);
    const { messages } = await fork.read(new AbortController().signal);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({ summarizedThroughMessageId: 'covered', savedTokens: 50 });
    expect(messages[1]).toMatchObject({ generatedBy: source });
    expect(messages[2]?.blocks).toEqual([{
      type: 'tool_result', toolCallId: 'read', content: '[已压短]',
      data: { value: '原始事实' }, durationMs: 9,
    }]);
    expect(rows.get('tool')?.blocks).toEqual(tool.blocks);
    expect(messages[3]).toMatchObject({ kind: 'continuation', blocks: '仅模型引导' });
  });
});
