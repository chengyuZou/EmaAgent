import { describe, it, expect } from 'vitest';
import { TtsClient } from '../src/service.js';
import type { TtsAdapter, TtsProviderConfig, TtsRequest, TtsStreamEvent, TtsVoiceRef } from '../src/types.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

function mockConfig(id: string, protocol = 'openai-tts' as const): TtsProviderConfig {
  return { id, protocol, apiKey: 'sk-test', baseUrl: 'http://localhost' };
}

function mockVoice(voiceUri = 'speech:test:abc123'): TtsVoiceRef {
  return { refAudioPath: '/abs/test.mp3', promptText: 'hello', promptLang: 'zh', voiceUri };
}

function mockVoiceNoUri(): TtsVoiceRef {
  return { refAudioPath: '/abs/test.mp3', promptText: 'hello', promptLang: 'zh' };
}

/** Captures every call to stream() and returns configurable chunks. */
function mockAdapter(chunks: TtsStreamEvent[] = []): TtsAdapter & { calls: TtsRequest[] } {
  const calls: TtsRequest[] = [];
  return {
    protocol: 'openai-tts' as const,
    capabilitiesFor: () => ({ audioDelivery: 'http_chunks', supportsAbort: true }),
    calls,
    stream: async function* (req: TtsRequest): AsyncIterable<TtsStreamEvent> {
      calls.push(req);
      for (const c of chunks) yield c;
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function collect(client: TtsClient, providerId: string, text: string, voice?: TtsVoiceRef): Promise<TtsStreamEvent[]> {
  const events: TtsStreamEvent[] = [];
  for await (const ev of client.synthesize({
    providerId,
    model: 'tts-1',
    text,
    voice: voice ?? mockVoice(),
  })) {
    events.push(ev);
  }
  return events;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TtsClient (dumb dispatcher)', () => {
  it('1. dispatches to correct adapter by providerId', async () => {
    const ad = mockAdapter([{ type: 'done', totalBytes: 0, firstByteMs: 0 }]);
    const client = new TtsClient(
      [mockConfig('p1'), mockConfig('p2')],
      new Map([['p1', ad]]),
    );

    await collect(client, 'p1', 'hello');

    expect(ad.calls).toHaveLength(1);
    expect(ad.calls[0]!.text).toBe('hello');
    expect(ad.calls[0]!.model).toBe('tts-1');
    expect(ad.calls[0]!.voice.voiceUri).toBe('speech:test:abc123');
  });

  it('2. errors on unknown providerId', async () => {
    const client = new TtsClient([mockConfig('p1')]);
    const events = await collect(client, 'unknown', 'hello');

    expect(events[0]!.type).toBe('error');
    expect((events[0] as { message: string }).message).toContain('not registered');
  });

  it('3. adapter rejects missing voiceUri (not TtsClient)', async () => {
    // TtsClient is a dumb dispatcher — voiceUri validation lives in each adapter.
    // The real OpenAiTtsAdapter (created for 'openai-tts' protocol) checks it.
    const client = new TtsClient([mockConfig('p1')]);
    const events = await collect(client, 'p1', 'hello', mockVoiceNoUri());

    expect(events[0]!.type).toBe('error');
    expect((events[0] as { message: string }).message).toContain('voiceUri');
  });

  it('4. yields adapter stream chunks directly', async () => {
    const chunks: TtsStreamEvent[] = [
      { type: 'audio_chunk', bytes: new Uint8Array([1, 2, 3]), mime: 'audio/mpeg' },
      { type: 'done', totalBytes: 3, firstByteMs: 10 },
    ];
    const ad = mockAdapter(chunks);
    const client = new TtsClient([mockConfig('p1')], new Map([['p1', ad]]));

    const events = await collect(client, 'p1', 'hello');

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('audio_chunk');
    expect(events[1]!.type).toBe('done');
  });

  it('5. filters text (strips markdown, URLs, inline code)', async () => {
    // ACT tags are stripped upstream by @ema-agent/emotion; TTS receives clean text.
    const ad = mockAdapter([{ type: 'done', totalBytes: 0, firstByteMs: 0 }]);
    const client = new TtsClient([mockConfig('p1')], new Map([['p1', ad]]));

    await collect(client, 'p1', '你好 [click](https://x.com) 世界');

    expect(ad.calls[0]!.text).toBe('你好 click 世界');
  });

  it('6. returns empty done when text filters to nothing', async () => {
    const client = new TtsClient([mockConfig('p1')]);
    // A pure URL string filters to the replacement word "链接" — not empty.
    // Use a string that becomes empty after stripping: only markdown punctuation.
    const events = await collect(client, 'p1', '---');

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('done');
    expect((events[0] as { totalBytes: number }).totalBytes).toBe(0);
  });

  it('7. hot-reload replaces adapters', async () => {
    const ad1 = mockAdapter([{ type: 'done', totalBytes: 1, firstByteMs: 0 }]);
    const client = new TtsClient([mockConfig('p1')], new Map([['p1', ad1]]));

    await collect(client, 'p1', 'hello');
    expect(ad1.calls).toHaveLength(1);

    client.reload([]);

    expect(client.firstProviderId()).toBeUndefined();
    const events = await collect(client, 'p1', 'new request');
    expect(events).toEqual([expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('not registered'),
    })]);
  });

  it('8. upsertConfig + removeConfig', () => {
    const client = new TtsClient([mockConfig('p1')]);

    expect(client.firstProviderId()).toBe('p1');

    client.upsertConfig(mockConfig('p2'));
    client.removeConfig('p1');

    expect(client.firstProviderId()).toBe('p2');
  });
});

describe('TtsClient 资源边界', () => {
  it('超过句级音频预算时终止流且只发一个终态错误', async () => {
    const ad = mockAdapter([
      { type: 'audio_chunk', bytes: new Uint8Array([1, 2]), mime: 'audio/mpeg' },
      { type: 'audio_chunk', bytes: new Uint8Array([3, 4]), mime: 'audio/mpeg' },
      { type: 'done', totalBytes: 4, firstByteMs: 1 },
    ]);
    const client = new TtsClient(
      [mockConfig('p1')],
      new Map([['p1', ad]]),
      { maxBytesPerSentence: 3 },
    );

    const events = await collect(client, 'p1', 'hello');
    expect(events.map((event) => event.type)).toEqual(['audio_chunk', 'error']);
    expect(events[1]).toMatchObject({ code: 'resource_exhausted' });
  });

  it('适配器不返回时由句级 deadline 结束', async () => {
    const adapter: TtsAdapter = {
      protocol: 'openai-tts',
      capabilitiesFor: () => ({ audioDelivery: 'http_chunks', supportsAbort: true }),
      stream: async function* () {
        await new Promise(() => undefined);
      },
    };
    const client = new TtsClient(
      [mockConfig('p1')],
      new Map([['p1', adapter]]),
      { timeoutMsPerSentence: 10 },
    );

    const events = await collect(client, 'p1', 'hello');
    expect(events).toEqual([expect.objectContaining({
      type: 'error',
      code: 'transient_timeout',
    })]);
  });

  it('适配器静默结束时补发 invalid_stream 终态', async () => {
    const ad = mockAdapter([]);
    const client = new TtsClient([mockConfig('p1')], new Map([['p1', ad]]));

    const events = await collect(client, 'p1', 'hello');
    expect(events).toEqual([expect.objectContaining({
      type: 'error',
      code: 'invalid_stream',
    })]);
  });
});
