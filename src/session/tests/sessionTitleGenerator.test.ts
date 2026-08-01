// 测试 Session 标题优先使用模型，并在模型失败时稳定回退到首条用户文本。
import { describe, expect, it, vi } from 'vitest';
import { asSessionId } from '@ema-agent/ids';
import { SessionTitleGenerator } from '../sessionTitleGenerator.js';

describe('SessionTitleGenerator', () => {
  it('清理模型返回的引号后保存标题', async () => {
    const fixture = createFixture(async () => '"Route boundary"');

    await expect(fixture.generator.generate(asSessionId('session-a')))
      .resolves.toBe('Route boundary');
    expect(fixture.patchSession).toHaveBeenCalledWith(
      'session-a',
      { title: 'Route boundary' },
    );
  });

  it('模型失败时截断首条用户消息，不让标题动作失败', async () => {
    const fixture = createFixture(async () => {
      throw new Error('provider unavailable');
    }, '  一段   很长但仍然可以作为确定性回退的用户消息  ');

    await expect(fixture.generator.generate(asSessionId('session-a')))
      .resolves.toBe('一段 很长但仍然可以作为确定性回退的用户消息');
  });

  it('历史按最新优先返回时仍使用最早的用户消息', async () => {
    const completeTitle = vi.fn(async () => 'Initial topic');
    const fixture = createFixture(completeTitle, [
      createUserMessage('后续补充'),
      createUserMessage('最初的问题'),
    ]);

    await expect(fixture.generator.generate(asSessionId('session-a')))
      .resolves.toBe('Initial topic');
    expect(completeTitle).toHaveBeenCalledWith(expect.stringContaining('最初的问题'));
    expect(completeTitle).not.toHaveBeenCalledWith(expect.stringContaining('后续补充'));
  });
});

function createFixture(
  completeTitle: (prompt: string) => Promise<string | undefined>,
  messages: string | ReturnType<typeof createUserMessage>[] = '请重构 Session Route',
) {
  const patchSession = vi.fn();
  const generator = new SessionTitleGenerator({
    listMessages: vi.fn(() => (typeof messages === 'string'
      ? [createUserMessage(messages)]
      : messages) as never),
    patchSession,
  }, { completeTitle });
  return { generator, patchSession };
}

function createUserMessage(text: string) {
  return {
    id: 'message-a',
    sessionId: 'session-a',
    turnId: 'turn-a',
    role: 'user',
    kind: 'normal',
    blocks: text,
    interrupted: false,
    createdAt: 1,
  } as const;
}
