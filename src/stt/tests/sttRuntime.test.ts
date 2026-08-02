// 测试 STT 运行时的热刷新、音频上限、超时和调用方取消。
import { describe, expect, it } from 'vitest';
import { SttRuntime } from '../sttRuntime.js';
import type { SttAdapter, SttProviderConfig } from '../types.js';
import { SttError } from '../errors.js';

const CONFIG: SttProviderConfig = {
  id: 'provider-1',
  protocol: 'openai-stt',
  apiKey: 'secret',
  baseUrl: 'https://example.test/v1',
};

function createRuntime(
  adapter: SttAdapter,
  limits: Partial<import('../types.js').SttLimits> = {},
): SttRuntime {
  return new SttRuntime({
    configs: [CONFIG],
    adapterOverrides: new Map([['provider-1', adapter]]),
    limits,
    usageRecorder: { record: () => undefined },
  });
}

describe('SttRuntime Provider 生命周期', () => {
  it('完整快照删除旧 Adapter，已开始的转写可以自然完成', async () => {
    let finish: ((value: { text: string }) => void) | undefined;
    const adapter: SttAdapter = {
      protocol: 'openai-stt',
      transcribe: () => new Promise((resolve) => {
        finish = resolve;
      }),
    };
    const client = createRuntime(adapter);
    const running = client.transcribe({
      providerId: 'provider-1',
      model: 'whisper-1',
      audio: new Uint8Array([1]),
      mime: 'audio/wav',
    });

    client.reload([]);

    await expect(client.transcribe({
      providerId: 'provider-1',
      model: 'whisper-1',
      audio: new Uint8Array([2]),
      mime: 'audio/wav',
    })).rejects.toThrow('stt/not_configured');
    finish?.({ text: 'completed' });
    await expect(running).resolves.toEqual({ text: 'completed' });
  });

  it('Probe 不向上透传 Adapter 原始错误文本', async () => {
    const adapter: SttAdapter = {
      protocol: 'openai-stt',
      transcribe: async () => ({ text: 'unused' }),
      probe: async () => ({ ok: false, error: 'secret provider response' }),
    };
    const runtime = createRuntime(adapter);

    await expect(runtime.probe('provider-1')).resolves.toEqual({
      providerId: 'provider-1',
      ok: false,
      error: 'stt/probe_failed',
    });
  });
});

describe('SttRuntime 请求边界', () => {
  it('在调用适配器前拒绝超过硬上限的音频', async () => {
    let called = false;
    const adapter: SttAdapter = {
      protocol: 'openai-stt',
      async transcribe() {
        called = true;
        return { text: 'unexpected' };
      },
    };
    const client = createRuntime(adapter, { maxAudioBytes: 2 });

    await expect(client.transcribe({
      providerId: 'provider-1',
      model: 'whisper-1',
      audio: new Uint8Array([1, 2, 3]),
      mime: 'audio/wav',
    })).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(called).toBe(false);
  });

  it('deadline 到达后取消适配器并返回结构化 timeout', async () => {
    const adapter: SttAdapter = {
      protocol: 'openai-stt',
      transcribe: ({ abortSignal }) => new Promise((_resolve, reject) => {
        abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      }),
    };
    const client = createRuntime(adapter, { timeoutMs: 10 });

    await expect(client.transcribe({
      providerId: 'provider-1',
      model: 'whisper-1',
      audio: new Uint8Array([1]),
      mime: 'audio/wav',
    })).rejects.toMatchObject({ code: 'timeout', retryable: true });
  });

  it('把上游取消稳定映射为 aborted', async () => {
    const upstream = new AbortController();
    const adapter: SttAdapter = {
      protocol: 'openai-stt',
      transcribe: ({ abortSignal }) => new Promise((_resolve, reject) => {
        abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      }),
    };
    const client = createRuntime(adapter);
    const running = client.transcribe({
      providerId: 'provider-1',
      model: 'whisper-1',
      audio: new Uint8Array([1]),
      mime: 'audio/wav',
      abortSignal: upstream.signal,
    });
    upstream.abort();

    await expect(running).rejects.toEqual(expect.objectContaining<Partial<SttError>>({
      code: 'aborted',
    }));
  });
});
