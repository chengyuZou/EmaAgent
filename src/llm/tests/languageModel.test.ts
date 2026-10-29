import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLLMCompletion, createLLMCall } from '../languageModel.js';
import type { LLMConnection, LLMRequest, LLMStreamEvent } from '../types.js';

const openAiMock = vi.hoisted(() => ({
  constructor: vi.fn(),
  create: vi.fn(),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation((config: unknown) => {
    openAiMock.constructor(config);
    return {
      chat: { completions: { create: openAiMock.create } },
      responses: { create: openAiMock.create },
    };
  }),
}));

const connection: LLMConnection = {
  providerId: 'test',
  protocol: 'openai-llm',
  apiKey: 'key',
  baseUrl: 'https://example.test/v1',
};
const request: LLMRequest = { messages: [{ role: 'user', content: 'hello' }] };

async function* streamOf(items: readonly unknown[]): AsyncIterable<unknown> {
  yield* items;
}

async function readEvents(stream: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

beforeEach(() => {
  openAiMock.constructor.mockReset();
  openAiMock.create.mockReset();
});

describe('createLLMCall', () => {
  it('首次消费才创建客户端, 固定连接并让并发和后续请求复用客户端', async () => {
    const mutableConnection = { ...connection };
    const call = createLLMCall(mutableConnection, 'test-model');
    const stream = call(request);
    expect(openAiMock.constructor).not.toHaveBeenCalled();
    expect(openAiMock.create).not.toHaveBeenCalled();

    Object.assign(mutableConnection, { apiKey: 'changed', baseUrl: 'https://changed.test/v1' });
    openAiMock.create.mockImplementation(() => Promise.resolve(streamOf([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ])));
    await Promise.all([readEvents(stream), readEvents(call(request))]);
    await readEvents(call(request));

    expect(openAiMock.constructor).toHaveBeenCalledTimes(1);
    expect(openAiMock.constructor).toHaveBeenCalledWith({
      apiKey: 'key', baseURL: 'https://example.test/v1', maxRetries: 0,
    });
    expect(openAiMock.create).toHaveBeenCalledTimes(3);
    expect(openAiMock.create.mock.calls.every(([params]) => params.model === 'test-model' && params.stream === true))
      .toBe(true);
  });

  it('自然断流没有结束原因时仍然报流协议错误', async () => {
    openAiMock.create.mockResolvedValueOnce(streamOf([
      { choices: [{ delta: { content: 'partial' }, finish_reason: null }] },
    ]));
    await expect(readEvents(createLLMCall(connection, 'model')(request)))
      .rejects.toMatchObject({ name: 'LLMStreamProtocolError', protocol: 'openai-llm' });
  });
});

describe('createLLMCompletion', () => {
  it('创建时固定连接, 首次请求才初始化, 并发和后续请求复用流式客户端', async () => {
    const mutableConnection = { ...connection };
    const complete = createLLMCompletion(mutableConnection, 'test-model');
    expect(openAiMock.constructor).not.toHaveBeenCalled();
    Object.assign(mutableConnection, { apiKey: 'changed', protocol: 'openai-responses-llm' });
    openAiMock.create.mockImplementation(() => Promise.resolve(streamOf([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ])));

    const results = await Promise.all([complete(request), complete(request)]);
    await complete(request);
    expect(results[0]).toEqual({
      blocks: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(openAiMock.constructor).toHaveBeenCalledTimes(1);
    expect(openAiMock.constructor).toHaveBeenCalledWith({
      apiKey: 'key', baseURL: 'https://example.test/v1', maxRetries: 0,
    });
    expect(openAiMock.create).toHaveBeenCalledTimes(3);
    expect(openAiMock.create.mock.calls.every(([params]) => params.model === 'test-model' && params.stream === true))
      .toBe(true);
  });

  it('只发一次流式请求, 保留思考, 正文, 工具参数和缓存用量', async () => {
    openAiMock.create.mockResolvedValueOnce(streamOf([{
      choices: [{
        delta: {
          reasoning_content: 'reason',
          content: 'answer',
          tool_calls: [{
            index: 0, id: 'call-1',
            type: 'function',
            function: { name: 'Read', arguments: '{"path":"a.txt"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    }]));
    const signal = new AbortController().signal;
    const tools = [{ name: 'Read', description: 'Read a file', inputSchema: { type: 'object' } }];
    await expect(createLLMCompletion(connection, 'model')({
      ...request, tools, thinking: { enabled: true, effort: 'high' },
      maxOutputTokens: 200, temperature: 0.2, signal,
    })).resolves.toEqual({
      blocks: [
        { type: 'thinking', thinking: 'reason' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'call-1', name: 'Read', args: { path: 'a.txt' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 3 },
    });
    expect(openAiMock.create).toHaveBeenCalledTimes(1);
    const [params, options] = openAiMock.create.mock.calls[0]!;
    expect(params).toMatchObject({
      messages: request.messages,
      stream: true,
      max_tokens: 200,
      temperature: 0.2,
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object' } } }],
    });
    expect(params.stream_options).toEqual({ include_usage: true });
    expect(options.signal.aborted).toBe(false);
  });

  it('SDK 错误原样拒绝, 不补发请求', async () => {
    const failure = new Error('request failed');
    openAiMock.create.mockRejectedValueOnce(failure);
    await expect(createLLMCompletion(connection, 'model')(request)).rejects.toBe(failure);
    expect(openAiMock.create).toHaveBeenCalledTimes(1);
  });

  it('非法工具参数拒绝整个结果', async () => {
    openAiMock.create.mockResolvedValueOnce(streamOf([{
      choices: [{
        delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'Read', arguments: '{' } }] },
        finish_reason: 'tool_calls',
      }],
    }]));
    await expect(createLLMCompletion(connection, 'model')(request))
      .rejects.toMatchObject({ name: 'LLMToolArgumentsParseError', callId: 'call-1', toolName: 'Read' });
  });

  it('没有 choice 或结束原因时不假装请求成功', async () => {
    openAiMock.create.mockResolvedValueOnce(streamOf([{ choices: [] }]));
    await expect(createLLMCompletion(connection, 'model')(request))
      .rejects.toMatchObject({ name: 'LLMStreamProtocolError', protocol: 'openai-llm' });
  });

  it('不支持的输入在 SDK 初始化前拒绝', async () => {
    await expect(createLLMCompletion(connection, 'model')({
      messages: [{ role: 'user', content: [{ type: 'file_data', data: 'YQ==', mimeType: 'text/plain' }] }],
    })).rejects.toMatchObject({ name: 'LLMProtocolInputError' });
    expect(openAiMock.constructor).not.toHaveBeenCalled();
    expect(openAiMock.create).not.toHaveBeenCalled();
  });

  it('调用前已经取消时不初始化 SDK', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    await expect(createLLMCompletion(connection, 'model')({ ...request, signal: controller.signal }))
      .rejects.toBe(reason);
    expect(openAiMock.constructor).not.toHaveBeenCalled();
    expect(openAiMock.create).not.toHaveBeenCalled();
  });

  it('共享初始化期间取消一个请求, 其他请求仍可执行', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel during initialization');
    const complete = createLLMCompletion(connection, 'model');
    openAiMock.constructor.mockImplementationOnce(() => controller.abort(reason));
    openAiMock.create.mockResolvedValueOnce(streamOf([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
    await expect(complete({ ...request, signal: controller.signal })).rejects.toBe(reason);
    expect(openAiMock.create).not.toHaveBeenCalled();
    await expect(complete(request)).resolves.toMatchObject({ blocks: [{ type: 'text', text: 'ok' }] });
    expect(openAiMock.constructor).toHaveBeenCalledTimes(1);
    expect(openAiMock.create).toHaveBeenCalledTimes(1);
  });
});

it.each([createLLMCall, createLLMCompletion])('空模型名在创建点失败', create => {
  expect(() => create(connection, ' ')).toThrow(TypeError);
});
