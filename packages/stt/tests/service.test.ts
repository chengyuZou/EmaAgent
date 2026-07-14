import { describe, expect, it } from 'vitest';
import { SttClient } from '../src/service.js';
import type { SttAdapter, SttProviderConfig } from '../src/types.js';

const CONFIG: SttProviderConfig = {
  id: 'provider-1',
  protocol: 'openai-stt',
  apiKey: 'secret',
  baseUrl: 'https://example.test/v1',
};

describe('SttClient Provider 生命周期', () => {
  it('完整快照删除旧 Adapter，已开始的转写可以自然完成', async () => {
    let finish: ((value: { text: string }) => void) | undefined;
    const adapter: SttAdapter = {
      protocol: 'openai-stt',
      transcribe: () => new Promise((resolve) => {
        finish = resolve;
      }),
    };
    const client = new SttClient([CONFIG], new Map([['provider-1', adapter]]));
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
});
