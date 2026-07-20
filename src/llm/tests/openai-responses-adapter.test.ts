import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAiResponsesAdapter } from '../adapters/openaiResponses.js';
import {
  ContextWindowExceededError,
  LlmProviderResponseError,
  LlmStreamProtocolError,
  LlmToolArgumentsParseError,
} from '../errors.js';
import type { LlmRequest, LlmStreamChunk, ProviderConfig } from '../types.js';

const openAiMock = vi.hoisted(() => ({
  constructor: vi.fn(),
  create: vi.fn(),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation((config: unknown) => {
    openAiMock.constructor(config);
    return {
      responses: {
        create: openAiMock.create,
      },
    };
  }),
}));

async function* streamOf(events: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  for (const event of events) yield event;
}

async function collect(stream: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const chunks: LlmStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function config(): ProviderConfig {
  return {
    id: 'openai-responses-test',
    protocol: 'openai-responses-llm',
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
  };
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    providerId: 'openai-responses-test',
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

function contextWindowError(): Error {
  return Object.assign(
    new Error('This model maximum context length has been exceeded'),
    { status: 400, code: 'context_length_exceeded' },
  );
}

describe('OpenAiResponsesAdapter — 统一错误与终态边界', () => {
  beforeEach(() => {
    openAiMock.constructor.mockClear();
    openAiMock.create.mockReset();
  });

  it('归一化请求创建阶段的上下文超限错误', async () => {
    openAiMock.create.mockRejectedValueOnce(contextWindowError());
    const adapter = new OpenAiResponsesAdapter(config());

    await expect(collect(adapter.stream(request(), 'gpt-test')))
      .rejects.toBeInstanceOf(ContextWindowExceededError);
  });

  it('归一化开始消费后的上下文超限错误', async () => {
    const failedStream = async function* (): AsyncIterable<Record<string, unknown>> {
      throw contextWindowError();
    };
    openAiMock.create.mockResolvedValueOnce(failedStream());
    const adapter = new OpenAiResponsesAdapter(config());

    await expect(collect(adapter.stream(request(), 'gpt-test')))
      .rejects.toBeInstanceOf(ContextWindowExceededError);
  });

  it('response.failed 转换为带稳定 Provider 字段的领域错误', async () => {
    openAiMock.create.mockResolvedValueOnce(streamOf([{
      type: 'response.failed',
      response: {
        error: { code: 'server_error', message: 'provider unavailable' },
      },
    }]));
    const adapter = new OpenAiResponsesAdapter(config());

    await expect(collect(adapter.stream(request(), 'gpt-test'))).rejects.toMatchObject({
      name: 'LlmProviderResponseError',
      providerId: 'openai-responses-test',
      providerCode: 'server_error',
      status: 503,
    } satisfies Partial<LlmProviderResponseError>);
  });

  it('error 事件中的 context code 同样触发上下文压缩领域错误', async () => {
    openAiMock.create.mockResolvedValueOnce(streamOf([{
      type: 'error',
      code: 'context_length_exceeded',
      message: 'context window exceeded',
      param: 'input',
    }]));
    const adapter = new OpenAiResponsesAdapter(config());

    await expect(collect(adapter.stream(request(), 'gpt-test')))
      .rejects.toBeInstanceOf(ContextWindowExceededError);
  });

  it('流未收到 completed/incomplete 就结束时拒绝伪造 done', async () => {
    openAiMock.create.mockResolvedValueOnce(streamOf([{
      type: 'response.output_text.delta',
      delta: 'partial',
    }]));
    const adapter = new OpenAiResponsesAdapter(config());

    await expect(collect(adapter.stream(request(), 'gpt-test')))
      .rejects.toBeInstanceOf(LlmStreamProtocolError);
  });

  it('response.incomplete 保留 usage 并映射明确的截断终态', async () => {
    openAiMock.create.mockResolvedValueOnce(streamOf([{
      type: 'response.output_text.delta',
      delta: 'partial',
    }, {
      type: 'response.incomplete',
      response: {
        incomplete_details: { reason: 'max_output_tokens' },
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          input_tokens_details: { cached_tokens: 2 },
        },
      },
    }]));
    const adapter = new OpenAiResponsesAdapter(config());

    await expect(collect(adapter.stream(request(), 'gpt-test'))).resolves.toEqual([
      { type: 'text_delta', blockIndex: 0, delta: 'partial' },
      {
        type: 'usage',
        inputTokens: 10,
        outputTokens: 4,
        cacheReadInputTokens: 2,
        cacheHitRate: 0.2,
      },
      { type: 'done', stopReason: 'max_tokens' },
    ]);
  });

  it('只有 response.completed 才产生正常 done', async () => {
    openAiMock.create.mockResolvedValueOnce(streamOf([{
      type: 'response.completed',
      response: { usage: null, incomplete_details: null },
    }]));
    const adapter = new OpenAiResponsesAdapter(config());

    await expect(collect(adapter.stream(request(), 'gpt-test'))).resolves.toEqual([
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('请求创建阶段取消时抛出 AbortError 而不是 done', async () => {
    const controller = new AbortController();
    openAiMock.create.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('SDK wrapped cancellation');
    });
    const adapter = new OpenAiResponsesAdapter(config());

    await expect(collect(adapter.stream(
      request({ signal: controller.signal }),
      'gpt-test',
    ))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('流消费阶段静默取消时抛出 AbortError 而不是 done', async () => {
    const controller = new AbortController();
    const cancelledStream = async function* (): AsyncIterable<Record<string, unknown>> {
      controller.abort();
    };
    openAiMock.create.mockResolvedValueOnce(cancelledStream());
    const adapter = new OpenAiResponsesAdapter(config());

    await expect(collect(adapter.stream(
      request({ signal: controller.signal }),
      'gpt-test',
    ))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('function_call_arguments.done 包含损坏 JSON 时抛出结构化协议错误', async () => {
    openAiMock.create.mockResolvedValueOnce(streamOf([{
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'item-invalid',
        call_id: 'call-invalid',
        name: 'delete_file',
        arguments: '',
      },
    }, {
      type: 'response.function_call_arguments.done',
      output_index: 0,
      arguments: '{"path":',
    }]));
    const adapter = new OpenAiResponsesAdapter(config());

    await expect(collect(adapter.stream(request(), 'gpt-test'))).rejects.toMatchObject({
      name: 'LlmToolArgumentsParseError',
      providerId: 'openai-responses-test',
      callId: 'call-invalid',
      toolName: 'delete_file',
      rawArgumentsExcerpt: '{"path":',
    } satisfies Partial<LlmToolArgumentsParseError>);
  });

  it('按响应事件顺序为文本和工具分配连续 blockIndex', async () => {
    openAiMock.create.mockResolvedValueOnce(streamOf([{
      type: 'response.output_text.delta',
      delta: '先检查',
    }, {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'item-1',
        call_id: 'call-1',
        name: 'read_file',
        arguments: '',
      },
    }, {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: '{"path":"a.txt"}',
    }, {
      type: 'response.function_call_arguments.done',
      output_index: 0,
      arguments: '{"path":"a.txt"}',
    }, {
      type: 'response.completed',
      response: { usage: null, incomplete_details: null },
    }]));
    const adapter = new OpenAiResponsesAdapter(config());

    await expect(collect(adapter.stream(request(), 'gpt-test'))).resolves.toEqual([
      { type: 'text_delta', blockIndex: 0, delta: '先检查' },
      {
        type: 'tool_use_delta',
        blockIndex: 1,
        callId: 'call-1',
        name: 'read_file',
        argsDelta: '{"path":"a.txt"}',
      },
      {
        type: 'tool_use_complete',
        blockIndex: 1,
        callId: 'call-1',
        name: 'read_file',
        args: { path: 'a.txt' },
      },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });
});
