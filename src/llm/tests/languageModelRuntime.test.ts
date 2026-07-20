// 测试语言模型运行时的 Provider 快照、能力检查、流式调用和完整结果聚合。
import { describe, it, expect } from 'vitest';
import { LanguageModelRuntime } from '../languageModelRuntime.js';
import { ModelsDevCatalog } from '../modelsDevCatalog.js';
import { LlmModelCapabilityError } from '../errors.js';
import type { LlmAdapter } from '../adapters/base.js';
import type { LlmContentPart, LlmRequest, LlmStreamChunk, ProviderConfig } from '../types.js';

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
  { type: 'tool_use_complete', blockIndex: 0, callId: 'call-1', name: 'bash', args: { cmd: 'ls' } },
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

describe('LanguageModelRuntime — routing', () => {
  it('streams all chunks through the correct adapter', async () => {
    const mock   = new MockAdapter(TEXT_CHUNKS);
    const router = new LanguageModelRuntime([DS_CONFIG], new Map([['ds-001', mock]]));

    const chunks = await collect(
      router.stream({ providerId: 'ds-001', model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'Hi' }] }),
    );

    expect(chunks).toEqual(TEXT_CHUNKS);
  });

  it('passes modelName directly to the adapter', async () => {
    const mock   = new MockAdapter([{ type: 'done', stopReason: 'end_turn' }]);
    const router = new LanguageModelRuntime([DS_CONFIG], new Map([['ds-001', mock]]));

    await collect(router.stream({ providerId: 'ds-001', model: 'deepseek-v4-pro', messages: [] }));

    expect(mock.calls[0]?.modelName).toBe('deepseek-v4-pro');
  });

  it('passes AbortSignal through to the adapter', async () => {
    const mock   = new MockAdapter([{ type: 'done', stopReason: 'end_turn' }]);
    const router = new LanguageModelRuntime([DS_CONFIG], new Map([['ds-001', mock]]));
    const signal = new AbortController().signal;

    await collect(router.stream({ providerId: 'ds-001', model: 'deepseek-v4-flash', messages: [], signal }));

    expect(mock.calls[0]?.request.signal).toBe(signal);
  });

  it('在 Adapter 边界规范化工具名称顺序和 Schema key 顺序', async () => {
    const mock = new MockAdapter([{ type: 'done', stopReason: 'end_turn' }]);
    const router = new LanguageModelRuntime([DS_CONFIG], new Map([['ds-001', mock]]));

    await collect(router.stream({
      providerId: 'ds-001',
      model: 'm',
      messages: [],
      tools: [
        { name: 'zeta', description: 'z', parameters: { type: 'object' } },
        {
          name: 'alpha',
          description: 'a',
          parameters: { required: ['path'], properties: {}, type: 'object' },
        },
      ],
    }));

    expect(mock.calls[0]?.request.tools?.map((tool) => tool.name)).toEqual(['alpha', 'zeta']);
    expect(Object.keys(mock.calls[0]?.request.tools?.[0]?.parameters ?? {}))
      .toEqual(['properties', 'required', 'type']);
  });

  it('routes two providers with the same protocol independently by id', async () => {
    const mockDS = new MockAdapter([{ type: 'done', stopReason: 'end_turn' }]);
    const mockSF = new MockAdapter([{ type: 'done', stopReason: 'end_turn' }]);
    const router = new LanguageModelRuntime([DS_CONFIG, SF_CONFIG], new Map([['ds-001', mockDS], ['sf-001', mockSF]]));

    await collect(router.stream({ providerId: 'ds-001', model: 'deepseek-v4-flash', messages: [] }));
    await collect(router.stream({ providerId: 'sf-001', model: 'Qwen2.5-72B',       messages: [] }));

    expect(mockDS.calls).toHaveLength(1);
    expect(mockSF.calls).toHaveLength(1);
  });

  it('streams tool_use_complete chunks unchanged', async () => {
    const mock   = new MockAdapter(TOOL_CHUNKS);
    const router = new LanguageModelRuntime([DS_CONFIG], new Map([['ds-001', mock]]));

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
    const router = new LanguageModelRuntime(configs, mocks);

    for (const cfg of configs) {
      const chunks = await collect(router.stream({ providerId: cfg.id, model: 'test', messages: [] }));
      expect(chunks.at(-1)?.type).toBe('done');
    }
  });
});

// ── Error cases ───────────────────────────────────────────────────────────────

describe('LanguageModelRuntime — error cases', () => {
  it('throws provider/not_configured for unknown provider id', () => {
    const router = new LanguageModelRuntime([]);
    expect(() => router.stream({ providerId: 'ghost', model: 'gpt-4o', messages: [] }))
      .toThrow('provider/not_configured');
  });

  it('throws synchronously so engines can fail-fast', () => {
    const router = new LanguageModelRuntime([]);
    expect(() => router.stream({ providerId: 'ghost', model: 'gpt-4o', messages: [] }))
      .toThrow();
  });
});

// ── Hot-reload ────────────────────────────────────────────────────────────────

describe('LanguageModelRuntime — hot-reload', () => {
  it('完整快照会删除旧 Provider，同时允许已取得的流自然结束', async () => {
    const mock = new MockAdapter(TEXT_CHUNKS);
    const router = new LanguageModelRuntime([DS_CONFIG], new Map([['ds-001', mock]]));
    const inFlight = router.stream({ providerId: 'ds-001', model: 'm', messages: [] });

    router.reload([]);

    expect(() => router.stream({ providerId: 'ds-001', model: 'm', messages: [] }))
      .toThrow('provider/not_configured');
    await expect(collect(inFlight)).resolves.toEqual(TEXT_CHUNKS);
  });

  it('upsertConfig makes a new provider available', async () => {
    const mock   = new MockAdapter([{ type: 'done', stopReason: 'end_turn' }]);
    const router = new LanguageModelRuntime([], new Map([['ds-001', mock]]));

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
    const router = new LanguageModelRuntime([DS_CONFIG], new Map([['ds-001', mock]]));

    router.removeConfig('ds-001');

    expect(() => router.stream({ providerId: 'ds-001', model: 'm', messages: [] }))
      .toThrow('provider/not_configured');
  });
});

describe('LanguageModelRuntime — model capability + compatibility recovery', () => {
  it('按 modelsDevId + model 精确解析同名模型能力', () => {
    const catalog = new ModelsDevCatalog();
    catalog.loadFromJson({
      providerA: {
        models: {
          shared: { modalities: { input: ['text', 'image'], output: ['text'] } },
        },
      },
      providerB: {
        models: {
          shared: { modalities: { input: ['text'], output: ['text'] } },
        },
      },
    });
    const router = new LanguageModelRuntime([
      { ...DS_CONFIG, id: 'a', modelsDevId: 'providerA' },
      { ...DS_CONFIG, id: 'b', modelsDevId: 'providerB' },
    ], undefined, catalog);

    expect(router.capabilitiesFor('a', 'shared').input.image).toBe('supported');
    expect(router.capabilitiesFor('b', 'shared').input.image).toBe('unsupported');
  });

  it('首 chunk 前明确拒绝可选参数时省略参数重试，并发出结构化降级', async () => {
    const requests: LlmRequest[] = [];
    const adapter: LlmAdapter = {
      async *stream(request) {
        requests.push(request);
        if (request.temperature !== undefined) {
          throw Object.assign(new Error('unsupported parameter: temperature'), { status: 400 });
        }
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const router = new LanguageModelRuntime([DS_CONFIG], new Map([['ds-001', adapter]]));

    const chunks = await collect(router.stream({
      providerId: 'ds-001', model: 'm', messages: [], temperature: 0.2,
    }));

    expect(requests).toHaveLength(2);
    expect(requests[0]?.temperature).toBe(0.2);
    expect(requests[1]?.temperature).toBeUndefined();
    expect(chunks).toEqual([
      expect.objectContaining({ type: 'request_degraded', attempt: 2, removed: ['parameter'] }),
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('兼容恢复与其他重试共享最多三次总预算', async () => {
    let calls = 0;
    const adapter: LlmAdapter = {
      async *stream(request) {
        calls++;
        if (request.temperature !== undefined) {
          throw Object.assign(new Error('unsupported temperature'), { status: 400 });
        }
        if (request.thinking !== undefined) {
          throw Object.assign(new Error('unsupported thinking parameter'), { status: 400 });
        }
        throw Object.assign(new Error('unsupported tool_choice parameter'), { status: 400 });
      },
    };
    const router = new LanguageModelRuntime([DS_CONFIG], new Map([['ds-001', adapter]]));

    await expect(collect(router.stream({
      providerId: 'ds-001',
      model: 'm',
      messages: [],
      temperature: 0.2,
      thinking: { enabled: 'auto' },
      toolChoice: 'auto',
    }))).rejects.toThrow('unsupported tool_choice');
    expect(calls).toBe(3);
  });

  it('首个 Provider chunk 产生后不执行参数兼容恢复', async () => {
    let calls = 0;
    const adapter: LlmAdapter = {
      async *stream() {
        calls++;
        yield { type: 'text_delta', blockIndex: 0, delta: 'partial' };
        throw Object.assign(new Error('unsupported parameter: temperature'), { status: 400 });
      },
    };
    const router = new LanguageModelRuntime([DS_CONFIG], new Map([['ds-001', adapter]]));

    await expect(collect(router.stream({
      providerId: 'ds-001', model: 'm', messages: [], temperature: 0.2,
    }))).rejects.toThrow('unsupported parameter: temperature');
    expect(calls).toBe(1);
  });

  it('Agent 工具结果重新组装后，最终门禁阻止嵌套图片进入纯文本模型', () => {
    const catalog = new ModelsDevCatalog();
    catalog.loadFromJson({
      providerA: {
        models: {
          textOnly: { modalities: { input: ['text'], output: ['text'] } },
        },
      },
    });
    const adapter = new MockAdapter();
    const router = new LanguageModelRuntime([
      { ...DS_CONFIG, modelsDevId: 'providerA' },
    ], new Map([['ds-001', adapter]]), catalog);

    expect(() => router.stream({
      providerId: 'ds-001',
      model: 'textOnly',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          toolUseId: 'call-1',
          content: [{ type: 'image_data', data: 'base64', mimeType: 'image/png' }],
        }],
      }],
    })).toThrow(LlmModelCapabilityError);
    expect(adapter.calls).toHaveLength(0);
  });
});

// ── getProtocol ───────────────────────────────────────────────────────────────

describe('LanguageModelRuntime — getProtocol', () => {
  it('returns the protocol for a registered provider', () => {
    const router = new LanguageModelRuntime([DS_CONFIG, CL_CONFIG, GM_CONFIG, OR_CONFIG]);
    expect(router.getProtocol('ds-001')).toBe('openai-llm');
    expect(router.getProtocol('cl-001')).toBe('anthropic-llm');
    expect(router.getProtocol('gm-001')).toBe('gemini-llm');
    expect(router.getProtocol('or-001')).toBe('openai-responses-llm');
  });

  it('returns undefined for an unknown provider', () => {
    const router = new LanguageModelRuntime([DS_CONFIG]);
    expect(router.getProtocol('ghost')).toBeUndefined();
  });
});

// ── Content-part validation ──────────────────────────────────────────────────

describe('LanguageModelRuntime — warnUnsupportedParts', () => {
  const HTTPS_IMAGE_URL: LlmContentPart = {
    type: 'image_url',
    url:  'https://example.test/image.png',
  };

  it('validates attachments against the registered provider protocol', () => {
    const router = new LanguageModelRuntime([DS_CONFIG, GM_CONFIG]);

    expect(router.warnUnsupportedParts('ds-001', [HTTPS_IMAGE_URL])).toEqual([]);

    const issues = router.warnUnsupportedParts('gm-001', [HTTPS_IMAGE_URL]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.index).toBe(0);
    expect(issues[0]?.reason).toContain('Gemini');
  });

  it('throws provider/not_configured instead of falling back to OpenAI rules', () => {
    const router = new LanguageModelRuntime([DS_CONFIG]);

    expect(() => router.warnUnsupportedParts('ghost', [HTTPS_IMAGE_URL]))
      .toThrow('provider/not_configured');
  });
});

// ── complete() ────────────────────────────────────────────────────────────────

describe('LanguageModelRuntime — complete()', () => {
  it('accumulates text_delta into a text block sorted by blockIndex', async () => {
    const chunks: LlmStreamChunk[] = [
      { type: 'text_delta', blockIndex: 0, delta: 'Hello' },
      { type: 'text_delta', blockIndex: 0, delta: ' world' },
      { type: 'usage',      inputTokens: 5, outputTokens: 3 },
      { type: 'done',       stopReason: 'end_turn' },
    ];
    const router = new LanguageModelRuntime([DS_CONFIG], new Map([['ds-001', new MockAdapter(chunks)]]));

    const result = await router.complete({ providerId: 'ds-001', model: 'm', messages: [] });

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toEqual({ type: 'text', text: 'Hello world' });
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  });

  it('完整保留 Provider 返回的缓存 Token 与命中率', async () => {
    const chunks: LlmStreamChunk[] = [
      {
        type: 'usage',
        inputTokens: 100,
        outputTokens: 8,
        cacheReadInputTokens: 75,
        cacheWriteInputTokens: 10,
        cacheHitRate: 0.75,
      },
      { type: 'done', stopReason: 'end_turn' },
    ];
    const router = new LanguageModelRuntime([CL_CONFIG], new Map([['cl-001', new MockAdapter(chunks)]]));

    const result = await router.complete({ providerId: 'cl-001', model: 'm', messages: [] });

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 8,
      cacheReadInputTokens: 75,
      cacheWriteInputTokens: 10,
      cacheHitRate: 0.75,
    });
  });

  it('reconstructs thinking block with signature from thinking_complete', async () => {
    const router = new LanguageModelRuntime([CL_CONFIG], new Map([['cl-001', new MockAdapter(THINKING_CHUNKS)]]));

    const result = await router.complete({ providerId: 'cl-001', model: 'm', messages: [] });

    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]).toEqual({ type: 'thinking', thinking: 'let me think...', signature: 'sig-abc' });
    expect(result.blocks[1]).toEqual({ type: 'text', text: 'The answer is 42.' });
  });

  it('sorts interleaved blocks by blockIndex', async () => {
    const chunks: LlmStreamChunk[] = [
      { type: 'text_delta',       blockIndex: 2, delta: 'text' },
      { type: 'tool_use_complete', blockIndex: 3, callId: 'c1', name: 'bash', args: {} },
      { type: 'thinking_delta',   blockIndex: 0, delta: 'think' },
      { type: 'thinking_complete', blockIndex: 0, signature: 's' },
      { type: 'done',             stopReason: 'tool_use' },
    ];
    const router = new LanguageModelRuntime([DS_CONFIG], new Map([['ds-001', new MockAdapter(chunks)]]));

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
    const router = new LanguageModelRuntime([DS_CONFIG], new Map([['ds-001', failAfterFirstChunk]]));

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
    const router = new LanguageModelRuntime([DS_CONFIG], new Map([['ds-001', failBeforeChunk]]));

    const result = await router.complete({ providerId: 'ds-001', model: 'm', messages: [] });

    expect(result.blocks[0]).toEqual({ type: 'text', text: 'ok' });
    expect(callCount).toBe(3);
  });
});

// ── defaultModelFor / firstProviderId ─────────────────────────────────────────

describe('LanguageModelRuntime — utility helpers', () => {
  const CFG_WITH_DEFAULT: ProviderConfig = {
    id: 'x-001', protocol: 'openai-llm', apiKey: 'k', defaultModel: 'gpt-4o',
  };

  it('defaultModelFor returns the configured default', () => {
    const router = new LanguageModelRuntime([CFG_WITH_DEFAULT]);
    expect(router.defaultModelFor('x-001')).toBe('gpt-4o');
  });

  it('defaultModelFor returns undefined when not set', () => {
    const router = new LanguageModelRuntime([DS_CONFIG]);
    expect(router.defaultModelFor('ds-001')).toBeUndefined();
  });

  it('firstProviderId returns the first registered id', () => {
    const router = new LanguageModelRuntime([DS_CONFIG, CL_CONFIG]);
    expect(router.firstProviderId()).toBe('ds-001');
  });

  it('firstProviderId returns undefined when empty', () => {
    expect(new LanguageModelRuntime([]).firstProviderId()).toBeUndefined();
  });
});
