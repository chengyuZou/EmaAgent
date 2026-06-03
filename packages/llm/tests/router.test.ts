import { describe, it, expect } from 'vitest';
import { LlmRouter } from '../src/router.js';
import type { LlmAdapter } from '../src/adapters/base.js';
import type { LlmContentPart, LlmRequest, LlmStreamChunk, ProviderConfig } from '../src/types.js';

// ── Mock adapter ──────────────────────────────────────────────────────────────

class MockAdapter implements LlmAdapter {
  readonly calls: { request: LlmRequest; modelName: string }[] = [];

  constructor(private readonly chunks: LlmStreamChunk[] = []) {}

  async *stream(request: LlmRequest, modelName: string): AsyncIterable<LlmStreamChunk> {
    this.calls.push({ request, modelName });
    for (const chunk of this.chunks) yield chunk;
  }
}

async function collect(iter: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const result: LlmStreamChunk[] = [];
  for await (const chunk of iter) result.push(chunk);
  return result;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DS_CONFIG: ProviderConfig = { id: 'ds-001', protocol: 'openai-llm',    apiKey: 'sk-ds' };
const SF_CONFIG: ProviderConfig = { id: 'sf-001', protocol: 'openai-llm',    apiKey: 'sk-sf' };
const CL_CONFIG: ProviderConfig = { id: 'cl-001', protocol: 'anthropic-llm', apiKey: 'sk-cl' };
const GM_CONFIG: ProviderConfig = { id: 'gm-001', protocol: 'gemini-llm',    apiKey: 'sk-gm' };
const OR_CONFIG: ProviderConfig = { id: 'or-001', protocol: 'openai-responses-llm', apiKey: 'sk-or' };

const TEXT_CHUNKS: LlmStreamChunk[] = [
  { type: 'text_delta', blockIndex: 0, delta: 'Hello' },
  { type: 'text_delta', blockIndex: 0, delta: ' world' },
  { type: 'usage',      inputTokens: 10, outputTokens: 5 },
  { type: 'done',       stopReason: 'end_turn' },
];

const TOOL_CHUNKS: LlmStreamChunk[] = [
  { type: 'tool_use_complete', blockIndex: 1000, callId: 'call-1', name: 'bash', args: { cmd: 'ls' } },
  { type: 'done', stopReason: 'tool_use' },
];

const THINKING_CHUNKS: LlmStreamChunk[] = [
  { type: 'thinking_delta',   blockIndex: 0, delta: 'let me think...' },
  { type: 'thinking_complete', blockIndex: 0, signature: 'sig-abc' },
  { type: 'text_delta',       blockIndex: 1, delta: 'The answer is 42.' },
  { type: 'usage',            inputTokens: 20, outputTokens: 15 },
  { type: 'done',             stopReason: 'end_turn' },
];

// ── Routing ───────────────────────────────────────────────────────────────────

describe('LlmRouter — routing', () => {
  it('streams all chunks through the correct adapter', async () => {
    const mock   = new MockAdapter(TEXT_CHUNKS);
    const router = new LlmRouter([DS_CONFIG], new Map([['ds-001', mock]]));

    const chunks = await collect(
      router.stream({ providerId: 'ds-001', model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'Hi' }] }),
    );

    expect(chunks).toEqual(TEXT_CHUNKS);
  });

  it('passes modelName directly to the adapter', async () => {
    const mock   = new MockAdapter();
    const router = new LlmRouter([DS_CONFIG], new Map([['ds-001', mock]]));

    await collect(router.stream({ providerId: 'ds-001', model: 'deepseek-v4-pro', messages: [] }));

    expect(mock.calls[0]?.modelName).toBe('deepseek-v4-pro');
  });

  it('passes AbortSignal through to the adapter', async () => {
    const mock   = new MockAdapter();
    const router = new LlmRouter([DS_CONFIG], new Map([['ds-001', mock]]));
    const signal = AbortSignal.abort();

    await collect(router.stream({ providerId: 'ds-001', model: 'deepseek-v4-flash', messages: [], signal }));

    expect(mock.calls[0]?.request.signal).toBe(signal);
  });

  it('routes two providers with the same protocol independently by id', async () => {
    const mockDS = new MockAdapter([{ type: 'done', stopReason: 'end_turn' }]);
    const mockSF = new MockAdapter([{ type: 'done', stopReason: 'end_turn' }]);
    const router = new LlmRouter([DS_CONFIG, SF_CONFIG], new Map([['ds-001', mockDS], ['sf-001', mockSF]]));

    await collect(router.stream({ providerId: 'ds-001', model: 'deepseek-v4-flash', messages: [] }));
    await collect(router.stream({ providerId: 'sf-001', model: 'Qwen2.5-72B',       messages: [] }));

    expect(mockDS.calls).toHaveLength(1);
    expect(mockSF.calls).toHaveLength(1);
  });

  it('streams tool_use_complete chunks unchanged', async () => {
    const mock   = new MockAdapter(TOOL_CHUNKS);
    const router = new LlmRouter([DS_CONFIG], new Map([['ds-001', mock]]));

    const chunks = await collect(router.stream({ providerId: 'ds-001', model: 'deepseek-v4-flash', messages: [] }));

    expect(chunks).toEqual(TOOL_CHUNKS);
  });

  it('all four protocols are routable', async () => {
    const configs  = [DS_CONFIG, CL_CONFIG, GM_CONFIG, OR_CONFIG];
    const mocks    = new Map<string, LlmAdapter>([
      ['ds-001', new MockAdapter([{ type: 'done', stopReason: 'end_turn' }])],
      ['cl-001', new MockAdapter([{ type: 'done', stopReason: 'end_turn' }])],
      ['gm-001', new MockAdapter([{ type: 'done', stopReason: 'end_turn' }])],
      ['or-001', new MockAdapter([{ type: 'done', stopReason: 'end_turn' }])],
    ]);
    const router = new LlmRouter(configs, mocks);

    for (const cfg of configs) {
      const chunks = await collect(router.stream({ providerId: cfg.id, model: 'test', messages: [] }));
      expect(chunks.at(-1)?.type).toBe('done');
    }
  });
});

// ── Error cases ───────────────────────────────────────────────────────────────

describe('LlmRouter — error cases', () => {
  it('throws provider/not_configured for unknown provider id', () => {
    const router = new LlmRouter([]);
    expect(() => router.stream({ providerId: 'ghost', model: 'gpt-4o', messages: [] }))
      .toThrow('provider/not_configured');
  });

  it('throws synchronously so engines can fail-fast', () => {
    const router = new LlmRouter([]);
    expect(() => router.stream({ providerId: 'ghost', model: 'gpt-4o', messages: [] }))
      .toThrow();
  });
});

// ── Hot-reload ────────────────────────────────────────────────────────────────

describe('LlmRouter — hot-reload', () => {
  it('upsertConfig makes a new provider available', async () => {
    const mock   = new MockAdapter([{ type: 'done', stopReason: 'end_turn' }]);
    const router = new LlmRouter([], new Map([['ds-001', mock]]));

    // Before upsert: unknown
    expect(() => router.stream({ providerId: 'ds-001', model: 'm', messages: [] }))
      .toThrow('provider/not_configured');

    router.upsertConfig(DS_CONFIG);

    // After upsert: reachable
    const chunks = await collect(router.stream({ providerId: 'ds-001', model: 'm', messages: [] }));
    expect(chunks.at(-1)?.type).toBe('done');
  });

  it('removeConfig makes a provider unavailable', () => {
    const mock   = new MockAdapter();
    const router = new LlmRouter([DS_CONFIG], new Map([['ds-001', mock]]));

    router.removeConfig('ds-001');

    expect(() => router.stream({ providerId: 'ds-001', model: 'm', messages: [] }))
      .toThrow('provider/not_configured');
  });
});

// ── getProtocol ───────────────────────────────────────────────────────────────

describe('LlmRouter — getProtocol', () => {
  it('returns the protocol for a registered provider', () => {
    const router = new LlmRouter([DS_CONFIG, CL_CONFIG, GM_CONFIG, OR_CONFIG]);
    expect(router.getProtocol('ds-001')).toBe('openai-llm');
    expect(router.getProtocol('cl-001')).toBe('anthropic-llm');
    expect(router.getProtocol('gm-001')).toBe('gemini-llm');
    expect(router.getProtocol('or-001')).toBe('openai-responses-llm');
  });

  it('returns undefined for an unknown provider', () => {
    const router = new LlmRouter([DS_CONFIG]);
    expect(router.getProtocol('ghost')).toBeUndefined();
  });
});

// ── Content-part validation ──────────────────────────────────────────────────

describe('LlmRouter — warnUnsupportedParts', () => {
  const HTTPS_IMAGE_URL: LlmContentPart = {
    type: 'image_url',
    url:  'https://example.test/image.png',
  };

  it('validates attachments against the registered provider protocol', () => {
    const router = new LlmRouter([DS_CONFIG, GM_CONFIG]);

    expect(router.warnUnsupportedParts('ds-001', [HTTPS_IMAGE_URL])).toEqual([]);

    const issues = router.warnUnsupportedParts('gm-001', [HTTPS_IMAGE_URL]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.index).toBe(0);
    expect(issues[0]?.reason).toContain('Gemini');
  });

  it('throws provider/not_configured instead of falling back to OpenAI rules', () => {
    const router = new LlmRouter([DS_CONFIG]);

    expect(() => router.warnUnsupportedParts('ghost', [HTTPS_IMAGE_URL]))
      .toThrow('provider/not_configured');
  });
});

// ── complete() ────────────────────────────────────────────────────────────────

describe('LlmRouter — complete()', () => {
  it('accumulates text_delta into a text block sorted by blockIndex', async () => {
    const chunks: LlmStreamChunk[] = [
      { type: 'text_delta', blockIndex: 0, delta: 'Hello' },
      { type: 'text_delta', blockIndex: 0, delta: ' world' },
      { type: 'usage',      inputTokens: 5, outputTokens: 3 },
      { type: 'done',       stopReason: 'end_turn' },
    ];
    const router = new LlmRouter([DS_CONFIG], new Map([['ds-001', new MockAdapter(chunks)]]));

    const result = await router.complete({ providerId: 'ds-001', model: 'm', messages: [] });

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toEqual({ type: 'text', text: 'Hello world' });
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  });

  it('reconstructs thinking block with signature from thinking_complete', async () => {
    const router = new LlmRouter([CL_CONFIG], new Map([['cl-001', new MockAdapter(THINKING_CHUNKS)]]));

    const result = await router.complete({ providerId: 'cl-001', model: 'm', messages: [] });

    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]).toEqual({ type: 'thinking', thinking: 'let me think...', signature: 'sig-abc' });
    expect(result.blocks[1]).toEqual({ type: 'text', text: 'The answer is 42.' });
  });

  it('sorts interleaved blocks by blockIndex', async () => {
    const chunks: LlmStreamChunk[] = [
      { type: 'text_delta',       blockIndex: 2, delta: 'text' },
      { type: 'tool_use_complete', blockIndex: 1000, callId: 'c1', name: 'bash', args: {} },
      { type: 'thinking_delta',   blockIndex: 0, delta: 'think' },
      { type: 'thinking_complete', blockIndex: 0, signature: 's' },
      { type: 'done',             stopReason: 'tool_use' },
    ];
    const router = new LlmRouter([DS_CONFIG], new Map([['ds-001', new MockAdapter(chunks)]]));

    const result = await router.complete({ providerId: 'ds-001', model: 'm', messages: [] });

    expect(result.blocks.map(b => b.type)).toEqual(['thinking', 'text', 'tool_use']);
  });

  it('does NOT retry after receiving the first chunk (hasStartedStreaming guard)', async () => {
    let callCount = 0;
    const failAfterFirstChunk: LlmAdapter = {
      async *stream() {
        callCount++;
        yield { type: 'text_delta', blockIndex: 0, delta: 'partial' };
        throw Object.assign(new Error('network drop'), { status: 500 });
      },
    };
    const router = new LlmRouter([DS_CONFIG], new Map([['ds-001', failAfterFirstChunk]]));

    await expect(
      router.complete({ providerId: 'ds-001', model: 'm', messages: [] }),
    ).rejects.toThrow('network drop');

    // mid-stream failure: called only once, not retried
    expect(callCount).toBe(1);
  });

  it('retries up to 3 times when connection fails before first chunk', async () => {
    let callCount = 0;
    const failBeforeChunk: LlmAdapter = {
      async *stream() {
        callCount++;
        if (callCount < 3) throw Object.assign(new Error('timeout'), { status: 429 });
        yield { type: 'text_delta', blockIndex: 0, delta: 'ok' };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const router = new LlmRouter([DS_CONFIG], new Map([['ds-001', failBeforeChunk]]));

    const result = await router.complete({ providerId: 'ds-001', model: 'm', messages: [] });

    expect(result.blocks[0]).toEqual({ type: 'text', text: 'ok' });
    expect(callCount).toBe(3);
  });
});

// ── defaultModelFor / firstProviderId ─────────────────────────────────────────

describe('LlmRouter — utility helpers', () => {
  const CFG_WITH_DEFAULT: ProviderConfig = {
    id: 'x-001', protocol: 'openai-llm', apiKey: 'k', defaultModel: 'gpt-4o',
  };

  it('defaultModelFor returns the configured default', () => {
    const router = new LlmRouter([CFG_WITH_DEFAULT]);
    expect(router.defaultModelFor('x-001')).toBe('gpt-4o');
  });

  it('defaultModelFor returns undefined when not set', () => {
    const router = new LlmRouter([DS_CONFIG]);
    expect(router.defaultModelFor('ds-001')).toBeUndefined();
  });

  it('firstProviderId returns the first registered id', () => {
    const router = new LlmRouter([DS_CONFIG, CL_CONFIG]);
    expect(router.firstProviderId()).toBe('ds-001');
  });

  it('firstProviderId returns undefined when empty', () => {
    expect(new LlmRouter([]).firstProviderId()).toBeUndefined();
  });
});
