import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../src/adapters/anthropic.js';
import { GeminiAdapter } from '../src/adapters/gemini.js';
import type { LlmRequest, LlmStreamChunk, ProviderConfig } from '../src/types.js';

const sdkMocks = vi.hoisted(() => ({
  anthropicStream: vi.fn(),
  geminiStream: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { stream: sdkMocks.anthropicStream },
  })),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContentStream: sdkMocks.geminiStream },
  })),
  FunctionCallingConfigMode: {
    AUTO: 'AUTO',
    NONE: 'NONE',
    ANY: 'ANY',
  },
}));

async function collect(stream: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const chunks: LlmStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function request(providerId: string, signal: AbortSignal): LlmRequest {
  return {
    providerId,
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    signal,
  };
}

function anthropicConfig(): ProviderConfig {
  return {
    id: 'anthropic-test',
    protocol: 'anthropic-llm',
    apiKey: 'sk-test',
  };
}

function geminiConfig(): ProviderConfig {
  return {
    id: 'gemini-test',
    protocol: 'gemini-llm',
    apiKey: 'sk-test',
  };
}

describe('Anthropic/Gemini Adapter — 取消传播', () => {
  beforeEach(() => {
    sdkMocks.anthropicStream.mockReset();
    sdkMocks.geminiStream.mockReset();
  });

  it('Anthropic 请求创建阶段取消时抛出 AbortError', async () => {
    const controller = new AbortController();
    sdkMocks.anthropicStream.mockImplementationOnce(() => {
      controller.abort();
      throw new Error('SDK wrapped cancellation');
    });
    const adapter = new AnthropicAdapter(anthropicConfig());

    await expect(collect(adapter.stream(
      request('anthropic-test', controller.signal),
      'claude-test',
    ))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('Anthropic 流静默结束但 signal 已取消时不得伪造 done', async () => {
    const controller = new AbortController();
    const cancelledStream = async function* (): AsyncIterable<Record<string, unknown>> {
      controller.abort();
    };
    sdkMocks.anthropicStream.mockReturnValueOnce(cancelledStream());
    const adapter = new AnthropicAdapter(anthropicConfig());

    await expect(collect(adapter.stream(
      request('anthropic-test', controller.signal),
      'claude-test',
    ))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('Gemini 请求创建阶段取消时抛出 AbortError', async () => {
    const controller = new AbortController();
    sdkMocks.geminiStream.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('SDK wrapped cancellation');
    });
    const adapter = new GeminiAdapter(geminiConfig());

    await expect(collect(adapter.stream(
      request('gemini-test', controller.signal),
      'gemini-test',
    ))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('Gemini 流静默结束但 signal 已取消时不得伪造 done', async () => {
    const controller = new AbortController();
    const cancelledStream = async function* (): AsyncIterable<Record<string, unknown>> {
      controller.abort();
    };
    sdkMocks.geminiStream.mockResolvedValueOnce(cancelledStream());
    const adapter = new GeminiAdapter(geminiConfig());

    await expect(collect(adapter.stream(
      request('gemini-test', controller.signal),
      'gemini-test',
    ))).rejects.toMatchObject({ name: 'AbortError' });
  });
});
