// 测试 TurnEventChannel 的顺序消费、finish/fail 终态与消费者关闭回调。
import { describe, expect, it, vi } from 'vitest';
import {
  TurnEventChannel,
  TurnEventChannelClosedError,
} from '../eventChannel.js';

function makeChannel() {
  const onConsumerClosed = vi.fn();
  const channel = new TurnEventChannel<string>(onConsumerClosed);
  return { channel, onConsumerClosed };
}

describe('TurnEventChannel', () => {
  it('事件按序交付，finish 后迭代器结束', async () => {
    const { channel } = makeChannel();
    channel.push('a');
    channel.push('b');
    channel.finish();

    const seen: string[] = [];
    for await (const value of channel) seen.push(value);
    expect(seen).toEqual(['a', 'b']);
  });

  it('事件流只允许一个消费者；并发 next 明确拒绝', async () => {
    const { channel } = makeChannel();
    channel[Symbol.asyncIterator]();
    expect(() => channel[Symbol.asyncIterator]()).toThrow(/one consumer/);

    const pending = channel.next();
    await expect(channel.next()).rejects.toThrow(/Concurrent reads/);
    channel.finish();
    expect((await pending).value).toBeUndefined();
  });

  it('fail 拒绝挂起的读取，关闭后 push 抛 ClosedError', async () => {
    const { channel } = makeChannel();
    const pending = channel.next();
    const failure = new Error('boom');
    channel.fail(failure);

    await expect(pending).rejects.toBe(failure);
    expect(() => channel.push('late')).toThrow(TurnEventChannelClosedError);
  });

  it('消费者 return 触发 onConsumerClosed 并关闭通道', async () => {
    const { channel, onConsumerClosed } = makeChannel();
    channel.push('a');

    const result = await channel.return!();
    expect(result.done).toBe(true);
    expect(onConsumerClosed).toHaveBeenCalledTimes(1);
    expect(() => channel.push('b')).toThrow(TurnEventChannelClosedError);
  });
});
