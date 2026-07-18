// 测试 Anthropic/Gemini 的取消传播、协议错误和 Provider Usage 快照。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../src/adapters/anthropic.js';
import { GeminiAdapter } from '../src/adapters/gemini.js';
import { LlmToolArgumentsParseError } from '../src/errors.js';
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

  it('Anthropic 在输入和输出计数可用时分别发送累计 Usage 快照', async () => {
    const completedStream = async function* (): AsyncIterable<Record<string, unknown>> {
      yield {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
          },
        },
      };
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 20 },
      };
    };
    sdkMocks.anthropicStream.mockReturnValueOnce(completedStream());
    const adapter = new AnthropicAdapter(anthropicConfig());

    const chunks = await collect(adapter.stream(
      request('anthropic-test', new AbortController().signal),
      'claude-test',
    ));
    const usage = chunks.filter((chunk) => chunk.type === 'usage');

    expect(usage.at(0)).toEqual(expect.objectContaining({
      inputTokens: 150,
      outputTokens: 0,
      cacheReadInputTokens: 40,
      cacheWriteInputTokens: 10,
    }));
    expect(usage.at(1)).toEqual(expect.objectContaining({
      inputTokens: 150,
      outputTokens: 20,
    }));
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
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

  it('Anthropic 工具参数 JSON 损坏时抛出结构化协议错误', async () => {
    const invalidToolStream = async function* (): AsyncIterable<Record<string, unknown>> {
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call-invalid',
          name: 'delete_file',
          input: {},
        },
      };
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      };
      yield { type: 'content_block_stop', index: 0 };
    };
    sdkMocks.anthropicStream.mockReturnValueOnce(invalidToolStream());
    const adapter = new AnthropicAdapter(anthropicConfig());

    await expect(collect(adapter.stream(
      request('anthropic-test', new AbortController().signal),
      'claude-test',
    ))).rejects.toMatchObject({
      name: 'LlmToolArgumentsParseError',
      providerId: 'anthropic-test',
      callId: 'call-invalid',
      toolName: 'delete_file',
      rawArgumentsExcerpt: '{"path":',
    } satisfies Partial<LlmToolArgumentsParseError>);
  });
});
