import { describe, it, expect } from 'vitest';
import { LlmRouter } from '../src/router.js';
import type { LlmAdapter } from '../src/adapters/base.js';
import type { LlmRequest, LlmStreamChunk, ProviderConfig } from '../src/types.js';

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

const DS_CONFIG: ProviderConfig  = { id: 'ds-001',  protocol: 'openai-llm',    apiKey: 'sk-ds' };
const SF_CONFIG: ProviderConfig  = { id: 'sf-001',  protocol: 'openai-llm',    apiKey: 'sk-sf' };
const CL_CONFIG: ProviderConfig  = { id: 'cl-001',  protocol: 'anthropic-llm', apiKey: 'sk-cl' };

const TEXT_CHUNKS: LlmStreamChunk[] = [
  { type: 'text_delta', delta: 'Hello' },
  { type: 'text_delta', delta: ' world' },
  { type: 'usage',      inputTokens: 10, outputTokens: 5 },
  { type: 'done',       stopReason: 'end_turn' },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LlmRouter — routing', () => {
  it('routes to the correct adapter by provider id and streams all chunks', async () => {
    const mock   = new MockAdapter(TEXT_CHUNKS);
    const router = new LlmRouter([DS_CONFIG], new Map<string, LlmAdapter>([['ds-001', mock]]));

    const chunks = await collect(
      router.stream({ providerId: 'ds-001', model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
    );

    expect(chunks).toEqual(TEXT_CHUNKS);
  });

  it('passes the model name directly to the adapter', async () => {
    const mock   = new MockAdapter();
    const router = new LlmRouter([DS_CONFIG], new Map<string, LlmAdapter>([['ds-001', mock]]));

    await collect(router.stream({ providerId: 'ds-001', model: 'gpt-4o-mini', messages: [] }));

    expect(mock.calls[0]?.modelName).toBe('gpt-4o-mini');
  });

  it('passes the full request (including signal) through to the adapter', async () => {
    const mock   = new MockAdapter();
    const router = new LlmRouter([DS_CONFIG], new Map<string, LlmAdapter>([['ds-001', mock]]));
    const signal = AbortSignal.abort();

    await collect(router.stream({ providerId: 'ds-001', model: 'gpt-4o', messages: [], signal }));

    expect(mock.calls[0]?.request.signal).toBe(signal);
  });

  it('routes two providers with the same protocol independently by id', async () => {
    const mockDS = new MockAdapter([{ type: 'done', stopReason: 'end_turn' }]);
    const mockSF = new MockAdapter([{ type: 'done', stopReason: 'end_turn' }]);

    const router = new LlmRouter(
      [DS_CONFIG, SF_CONFIG],
      new Map<string, LlmAdapter>([['ds-001', mockDS], ['sf-001', mockSF]]),
    );

    await collect(router.stream({ providerId: 'ds-001', model: 'deepseek-chat',     messages: [] }));
    await collect(router.stream({ providerId: 'sf-001', model: 'Qwen2.5-72B',       messages: [] }));

    expect(mockDS.calls).toHaveLength(1);
    expect(mockSF.calls).toHaveLength(1);
  });
});

describe('LlmRouter — error cases', () => {
  it('throws provider/not_configured when provider id is not registered', () => {
    const router = new LlmRouter([]);
    expect(() => router.stream({ providerId: 'unknown', model: 'gpt-4o', messages: [] }))
      .toThrow('provider/not_configured');
  });

  it('throws synchronously so the engine can fail-fast', () => {
    const router = new LlmRouter([]);
    expect(() => router.stream({ providerId: 'unknown', model: 'gemini-2.0-flash', messages: [] }))
      .toThrow();
  });
});

describe('LlmRouter — hot-reload', () => {
  it('removeConfig makes the provider unavailable', () => {
    const mock   = new MockAdapter();
    const router = new LlmRouter([OPENAI_CONFIG], new Map<LlmProvider, LlmAdapter>([['openai-llm', mock]]));

    router.removeConfig('openai');

    expect(() => router.stream({ protocol: 'openai-llm', model: 'gpt-4o', messages: [] }))
      .toThrow('unknown_provider');
  });
});

describe('LlmRouter — chunk shapes', () => {
  it('streams tool_use_complete chunks through unchanged', async () => {
    const toolChunks: LlmStreamChunk[] = [
      { type: 'tool_use_complete', callId: 'call-1', name: 'bash', args: { cmd: 'ls' } },
      { type: 'done', stopReason: 'tool_use' },
    ];
    const mock   = new MockAdapter(toolChunks);
    const router = new LlmRouter([OPENAI_CONFIG], new Map<LlmProvider, LlmAdapter>([['openai-llm', mock]]));

    const chunks = await collect(router.stream({ protocol: 'openai-llm', model: 'gpt-4o', messages: [] }));
    expect(chunks).toEqual(toolChunks);
  });
});
