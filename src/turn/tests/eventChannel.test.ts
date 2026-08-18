// 测试 TurnEventChannel 的单消费者、有界反压、finish/fail 终态与消费者关闭回调。
import { describe, expect, it, vi } from 'vitest';
import {
  TurnEventChannel,
  TurnEventChannelClosedError,
} from '../eventChannel.js';

function makeChannel(capacity = 2) {
  const onConsumerClosed = vi.fn();
  const channel = new TurnEventChannel<string>(onConsumerClosed, capacity);
  return { channel, onConsumerClosed };
}

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('TurnEventChannel', () => {
  it('容量必须是正整数', () => {
    expect(() => new TurnEventChannel(() => undefined, 0)).toThrow(RangeError);
  });

  it('事件按序交付，finish 后迭代器结束', async () => {
    const { channel } = makeChannel();
    await channel.push('a');
    await channel.push('b');
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

  it('缓冲区满时 push 反压阻塞，消费一个后放行', async () => {
    const { channel } = makeChannel(2);
    await channel.push('a');
    await channel.push('b');

    let thirdResolved = false;
    const third = channel.push('c').then(() => { thirdResolved = true; });
    await tick();
    expect(thirdResolved).toBe(false);

    expect((await channel.next()).value).toBe('a');
    await third;
    expect(thirdResolved).toBe(true);
  });

  it('fail 拒绝挂起的读取，关闭后 push 抛 ClosedError', async () => {
    const { channel } = makeChannel();
    const pending = channel.next();
    const failure = new Error('boom');
    channel.fail(failure);

    await expect(pending).rejects.toBe(failure);
    await expect(channel.push('late')).rejects.toBeInstanceOf(TurnEventChannelClosedError);
  });

  it('消费者 return 触发 onConsumerClosed 并关闭通道', async () => {
    const { channel, onConsumerClosed } = makeChannel();
    await channel.push('a');

    const result = await channel.return!();
    expect(result.done).toBe(true);
    expect(onConsumerClosed).toHaveBeenCalledTimes(1);
    await expect(channel.push('b')).rejects.toBeInstanceOf(TurnEventChannelClosedError);
  });

  it('反压中的生产者在 finish 后放行并以 ClosedError 失败', async () => {
    const { channel } = makeChannel(1);
    await channel.push('a');
    const blocked = channel.push('b');
    channel.finish();
    await expect(blocked).rejects.toBeInstanceOf(TurnEventChannelClosedError);
  });
});
