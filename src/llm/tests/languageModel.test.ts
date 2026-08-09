// 测试 LLM 公共入口只执行一次协议请求，并从同一条流收集完整结果。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLanguageModel } from '../languageModel.js';

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

async function* streamOf(items: readonly unknown[]): AsyncIterable<unknown> {
  for (const item of items) yield item;
}

describe('createLanguageModel', () => {
  beforeEach(() => {
    openAiMock.constructor.mockClear();
    openAiMock.create.mockReset();
  });

  it('创建时冻结连接并关闭 SDK 内建重试', () => {
    const llm = createLanguageModel({
      protocol: 'openai-llm',
      apiKey: 'key',
      baseUrl: 'https://example.test/v1',
    });

    expect(llm.protocol).toBe('openai-llm');
    expect(openAiMock.constructor).toHaveBeenCalledWith({
      apiKey: 'key',
      baseURL: 'https://example.test/v1',
      maxRetries: 0,
    });
  });

  it('complete 收集 text、tool、usage 和显式终态', async () => {
    openAiMock.create.mockResolvedValueOnce(streamOf([
      { choices: [{ delta: { content: '先读' }, finish_reason: null }] },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call-1',
              function: { name: 'Read', arguments: '{"path":"a.txt"}' },
            }],
          },
          finish_reason: null,
        }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      {
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      },
    ]));
    const llm = createLanguageModel({ protocol: 'openai-llm', apiKey: 'key' });

    await expect(llm.complete({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    })).resolves.toEqual({
      blocks: [
        { type: 'text', text: '先读' },
        { type: 'tool_use', id: 'call-1', name: 'Read', args: { path: 'a.txt' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    expect(openAiMock.create).toHaveBeenCalledTimes(1);
  });

  it('没有协议终态的自然断流不得生成完成结果', async () => {
    openAiMock.create.mockResolvedValueOnce(streamOf([
      { choices: [{ delta: { content: 'partial' }, finish_reason: null }] },
    ]));
    const llm = createLanguageModel({ protocol: 'openai-llm', apiKey: 'key' });

    await expect(llm.complete({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    })).rejects.toMatchObject({
      name: 'LlmStreamProtocolError',
      protocol: 'openai-llm',
    });
  });

  it('OpenAI Responses 使用相同公共入口和显式 completed 终态', async () => {
    openAiMock.create.mockResolvedValueOnce(streamOf([{
      type: 'response.output_text.delta',
      delta: 'ok',
    }, {
      type: 'response.completed',
      response: { usage: null, incomplete_details: null },
    }]));
    const llm = createLanguageModel({
      protocol: 'openai-responses-llm',
      apiKey: 'key',
    });

    await expect(llm.complete({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
    })).resolves.toEqual({
      blocks: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });
});
