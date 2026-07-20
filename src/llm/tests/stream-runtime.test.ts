import { describe, expect, it } from 'vitest';
import {
  CircuitOpenError,
  LlmStreamProtocolError,
} from '../errors.js';
import { LlmStreamRuntime } from '../stream-runtime.js';
import type { LlmStreamChunk } from '../types.js';

async function collect(stream: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const chunks: LlmStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function runtime(maxAttempts = 1): LlmStreamRuntime {
  return new LlmStreamRuntime({
    maxAttempts,
    baseDelayMs: 0,
    wait: async () => undefined,
  });
}

function serverError(message: string): Error {
  return Object.assign(new Error(message), { status: 500 });
}

describe('LlmStreamRuntime', () => {
  it('首 chunk 后失败会累计熔断，但绝不重试当前流', async () => {
    const subject = runtime();
    let starts = 0;
    const start = async function* (): AsyncIterable<LlmStreamChunk> {
      starts++;
      yield { type: 'text_delta', blockIndex: 0, delta: 'partial' };
      throw serverError('mid-stream failure');
    };

    for (let i = 0; i < 3; i++) {
      await expect(collect(subject.stream('provider-1', start)))
        .rejects.toThrow('mid-stream failure');
    }

    expect(starts).toBe(3);
    await expect(collect(subject.stream('provider-1', start)))
      .rejects.toBeInstanceOf(CircuitOpenError);
    expect(starts).toBe(3);
  });

  it('只有 done 成功终态才重置连续失败计数', async () => {
    const subject = runtime();
    let mode: 'fail' | 'done' = 'fail';
    let starts = 0;
    const start = async function* (): AsyncIterable<LlmStreamChunk> {
      starts++;
      if (mode === 'fail') throw serverError('provider failure');
      yield { type: 'done', stopReason: 'end_turn' };
    };

    await expect(collect(subject.stream('provider-1', start))).rejects.toThrow('provider failure');
    await expect(collect(subject.stream('provider-1', start))).rejects.toThrow('provider failure');

    mode = 'done';
    await expect(collect(subject.stream('provider-1', start))).resolves.toEqual([
      { type: 'done', stopReason: 'end_turn' },
    ]);

    mode = 'fail';
    await expect(collect(subject.stream('provider-1', start))).rejects.toThrow('provider failure');
    await expect(collect(subject.stream('provider-1', start))).rejects.toThrow('provider failure');

    mode = 'done';
    await expect(collect(subject.stream('provider-1', start))).resolves.toEqual([
      { type: 'done', stopReason: 'end_turn' },
    ]);
    expect(starts).toBe(6);
  });

  it('流交付 chunk 后自然结束但缺少 done 时按协议失败处理', async () => {
    const subject = runtime();
    const start = async function* (): AsyncIterable<LlmStreamChunk> {
      yield { type: 'text_delta', blockIndex: 0, delta: 'incomplete' };
    };

    await expect(collect(subject.stream('provider-1', start)))
      .rejects.toBeInstanceOf(LlmStreamProtocolError);
  });

  it('首 chunk 前的空流可安全重试，但最终仍要求 done', async () => {
    const subject = runtime(3);
    let starts = 0;
    const start = async function* (): AsyncIterable<LlmStreamChunk> {
      starts++;
    };

    await expect(collect(subject.stream('provider-1', start)))
      .rejects.toBeInstanceOf(LlmStreamProtocolError);
    expect(starts).toBe(3);
  });

  it('用户取消不计入 Provider 熔断失败', async () => {
    const subject = runtime();
    let mode: 'abort' | 'done' = 'abort';
    let starts = 0;
    const start = async function* (): AsyncIterable<LlmStreamChunk> {
      starts++;
      if (mode === 'abort') {
        const error = new Error('cancelled by user');
        error.name = 'AbortError';
        throw error;
      }
      yield { type: 'done', stopReason: 'end_turn' };
    };

    for (let i = 0; i < 3; i++) {
      await expect(collect(subject.stream('provider-1', start)))
        .rejects.toMatchObject({ name: 'AbortError' });
    }

    mode = 'done';
    await expect(collect(subject.stream('provider-1', start))).resolves.toEqual([
      { type: 'done', stopReason: 'end_turn' },
    ]);
    expect(starts).toBe(4);
  });

  it('请求参数等不可重试错误不污染 Provider 熔断统计', async () => {
    const subject = runtime();
    let mode: 'client-error' | 'done' = 'client-error';
    let starts = 0;
    const start = async function* (): AsyncIterable<LlmStreamChunk> {
      starts++;
      if (mode === 'client-error') {
        throw Object.assign(new Error('invalid request'), { status: 400 });
      }
      yield { type: 'done', stopReason: 'end_turn' };
    };

    for (let i = 0; i < 4; i++) {
      await expect(collect(subject.stream('provider-1', start)))
        .rejects.toThrow('invalid request');
    }

    mode = 'done';
    await expect(collect(subject.stream('provider-1', start))).resolves.toEqual([
      { type: 'done', stopReason: 'end_turn' },
    ]);
    expect(starts).toBe(5);
  });

  it('half-open 同一时刻只允许一个探针流进入 Adapter', async () => {
    const subject = new LlmStreamRuntime({
      maxAttempts: 1,
      baseDelayMs: 0,
      wait: async () => undefined,
      circuitBreaker: { cooldownMs: 0 },
    });

    const fail = async function* (): AsyncIterable<LlmStreamChunk> {
      throw serverError('provider failure');
    };
    for (let i = 0; i < 3; i++) {
      await expect(collect(subject.stream('provider-1', fail)))
        .rejects.toThrow('provider failure');
    }

    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let probeStarts = 0;
    const probe = async function* (): AsyncIterable<LlmStreamChunk> {
      probeStarts++;
      await probeGate;
      yield { type: 'done', stopReason: 'end_turn' };
    };

    const firstIterator = subject.stream('provider-1', probe)[Symbol.asyncIterator]();
    const firstChunk = firstIterator.next();
    await Promise.resolve();

    await expect(collect(subject.stream('provider-1', probe)))
      .rejects.toBeInstanceOf(CircuitOpenError);
    expect(probeStarts).toBe(1);

    releaseProbe();
    await expect(firstChunk).resolves.toEqual({
      done: false,
      value: { type: 'done', stopReason: 'end_turn' },
    });
    await firstIterator.return?.();
  });

  it('half-open 消费者在 done 前停止迭代时释放探针许可', async () => {
    const subject = new LlmStreamRuntime({
      maxAttempts: 1,
      baseDelayMs: 0,
      wait: async () => undefined,
      circuitBreaker: { cooldownMs: 0 },
    });

    const fail = async function* (): AsyncIterable<LlmStreamChunk> {
      throw serverError('provider failure');
    };
    for (let i = 0; i < 3; i++) {
      await expect(collect(subject.stream('provider-1', fail)))
        .rejects.toThrow('provider failure');
    }

    const incompleteProbe = async function* (): AsyncIterable<LlmStreamChunk> {
      yield { type: 'text_delta', blockIndex: 0, delta: 'probe' };
      yield { type: 'done', stopReason: 'end_turn' };
    };
    const iterator = subject.stream('provider-1', incompleteProbe)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'text_delta', blockIndex: 0, delta: 'probe' },
    });
    await iterator.return?.();

    const healthyProbe = async function* (): AsyncIterable<LlmStreamChunk> {
      yield { type: 'done', stopReason: 'end_turn' };
    };
    await expect(collect(subject.stream('provider-1', healthyProbe))).resolves.toEqual([
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });
});
