import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAiAdapter } from '../src/adapters/openai.js';
import type { LlmRequest, LlmStreamChunk, ProviderConfig } from '../src/types.js';

const openAiMock = vi.hoisted(() => ({
  constructor: vi.fn(),
  create:      vi.fn(),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation((config: unknown) => {
    openAiMock.constructor(config);
    return {
      chat: {
        completions: {
          create: openAiMock.create,
        },
      },
    };
  }),
}));

async function* streamOf(chunks: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  for (const chunk of chunks) yield chunk;
}

async function collect(iter: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const chunks: LlmStreamChunk[] = [];
  for await (const chunk of iter) chunks.push(chunk);
  return chunks;
}

function config(): ProviderConfig {
  return {
    id:       'deepseek-test',
    protocol: 'openai-llm',
    apiKey:   'sk-test',
    baseUrl:  'https://api.deepseek.com',
  };
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    providerId: 'deepseek-test',
    model:      'deepseek-v4-flash',
    messages:   [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

function completeStream(content = 'ok'): AsyncIterable<Record<string, unknown>> {
  return streamOf([
    { choices: [{ delta: { content }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } },
  ]);
}

async function runAndGetBody(req: LlmRequest): Promise<Record<string, unknown>> {
  openAiMock.create.mockResolvedValueOnce(completeStream());
  const adapter = new OpenAiAdapter(config());

  await collect(adapter.stream(req, req.model));

  const firstCall = openAiMock.create.mock.calls[0];
  expect(firstCall).toBeDefined();
  return firstCall?.[0] as Record<string, unknown>;
}

describe('OpenAiAdapter — thinking controls', () => {
  beforeEach(() => {
    openAiMock.constructor.mockClear();
    openAiMock.create.mockReset();
  });

  it('does not send provider-specific thinking fields by default', async () => {
    const body = await runAndGetBody(request());

    expect(body['thinking']).toBeUndefined();
    expect(body['reasoning_effort']).toBeUndefined();
  });

  it('sends DeepSeek-compatible thinking disabled when requested', async () => {
    const body = await runAndGetBody(request({
      thinking: { enabled: false },
    }));

    expect(body['thinking']).toEqual({ type: 'disabled' });
    expect(body['reasoning_effort']).toBeUndefined();
  });

  it('sends DeepSeek-compatible thinking enabled with effort', async () => {
    const body = await runAndGetBody(request({
      thinking: { enabled: true, effort: 'max' },
    }));

    expect(body['thinking']).toEqual({ type: 'enabled' });
    expect(body['reasoning_effort']).toBe('max');
  });

  it('leaves the on/off flag to the provider when thinking is auto', async () => {
    const body = await runAndGetBody(request({
      thinking: { enabled: 'auto', effort: 'high' },
    }));

    expect(body['thinking']).toBeUndefined();
    expect(body['reasoning_effort']).toBe('high');
  });

  it('normalizes DeepSeek reasoning_content into thinking_delta chunks', async () => {
    openAiMock.create.mockResolvedValueOnce(streamOf([
      { choices: [{ delta: { reasoning_content: 'think' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]));
    const adapter = new OpenAiAdapter(config());

    const chunks = await collect(adapter.stream(request(), 'deepseek-v4-flash'));

    expect(chunks).toEqual([
      { type: 'thinking_delta', blockIndex: 0, delta: 'think' },
      { type: 'text_delta', blockIndex: 1, delta: 'answer' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('SDK 收到取消后静默结束流时不得伪造 done', async () => {
    const controller = new AbortController();
    const cancelledStream = async function* (): AsyncIterable<Record<string, unknown>> {
      controller.abort();
    };
    openAiMock.create.mockResolvedValueOnce(cancelledStream());
    const adapter = new OpenAiAdapter(config());

    await expect(collect(adapter.stream(
      request({ signal: controller.signal }),
      'deepseek-v4-flash',
    ))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('请求创建阶段取消时抛出 AbortError', async () => {
    const controller = new AbortController();
    openAiMock.create.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('SDK wrapped cancellation');
    });
    const adapter = new OpenAiAdapter(config());

    await expect(collect(adapter.stream(
      request({ signal: controller.signal }),
      'deepseek-v4-flash',
    ))).rejects.toMatchObject({ name: 'AbortError' });
  });
});
