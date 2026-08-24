// 测试 OpenAI Responses 协议的同一调用目标 reasoning 重放裁决，以及流中真实 reasoning item 状态收集。
import { describe, expect, it, vi } from 'vitest';
import { createOpenAiResponsesProtocol, toResponsesInput } from '../protocols/openAiResponses.js';
import type { LlmStreamEvent } from '../types.js';

const sdkMocks = vi.hoisted(() => ({
  openaiConstructor: vi.fn(),
  responsesCreate: vi.fn(),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation((config: unknown) => {
    sdkMocks.openaiConstructor(config);
    return { responses: { create: sdkMocks.responsesCreate } };
  }),
}));

async function* streamOf(items: readonly unknown[]): AsyncIterable<unknown> {
  for (const item of items) yield item;
}

describe('streamOpenAiResponses reasoning item 收集', () => {
  it('从流中收集真实 reasoning item（id + encrypted_content）并在完成时发 thinking_complete', async () => {
    sdkMocks.responsesCreate.mockResolvedValueOnce(streamOf([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'rsn_1', type: 'reasoning', summary: [] },
      },
      {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        item_id: 'rsn_1',
        delta: '分析',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'rsn_1', type: 'reasoning', encrypted_content: 'enc-1', summary: [] },
      },
      { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_1', delta: '结果' },
      {
        type: 'response.completed',
        response: {
          usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
        },
      },
    ]));

    const llm = createOpenAiResponsesProtocol(
      { providerId: 'openai', protocol: 'openai-responses-llm', apiKey: 'key' },
      'gpt-5.2',
    );
    const events: LlmStreamEvent[] = [];
    for await (const event of llm({
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 128,
      thinking: { enabled: true, effort: 'medium' },
    })) {
      events.push(event);
    }

    expect(events.find(event => event.type === 'thinking_delta')?.delta).toBe('分析');
    expect(events.find(event => event.type === 'thinking_complete')).toEqual({
      type: 'thinking_complete',
      blockIndex: 0,
      state: { kind: 'openai', id: 'rsn_1', encryptedContent: 'enc-1' },
    });
    expect(events.find(event => event.type === 'text_delta')?.delta).toBe('结果');
  });

  it('reasoning 开启时请求声明 encrypted_content 以收集原生续接状态', async () => {
    sdkMocks.responsesCreate.mockResolvedValueOnce(streamOf([{
      type: 'response.completed',
      response: {
        usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
      },
    }]));

    const llm = createOpenAiResponsesProtocol(
      { providerId: 'openai', protocol: 'openai-responses-llm', apiKey: 'key' },
      'gpt-5.2',
    );
    for await (const _event of llm({
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 128,
      thinking: { enabled: true, effort: 'medium' },
    })) {
      // 消费完整个流
    }

    expect(sdkMocks.responsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ include: ['reasoning.encrypted_content'] }),
      expect.anything(),
    );
  });
});

describe('toResponsesInput reasoning 重放', () => {
  it('同目标生成的 reasoning 原样重放（真实 id + encrypted_content 透传）', () => {
    const { input } = toResponsesInput([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', id: 'rsn_1', summaryText: '分析步骤', encryptedContent: 'enc-abc' },
          { type: 'text', text: '结果' },
        ],
        generatedBy: { providerId: 'openai', modelId: 'gpt-5.2', protocol: 'openai-responses-llm' },
      },
    ], 'openai', 'gpt-5.2');

    expect(input).toHaveLength(2);
    expect(input[0]).toEqual({
      type: 'reasoning',
      id: 'rsn_1',
      encrypted_content: 'enc-abc',
      summary: [{ type: 'summary_text', text: '分析步骤' }],
    });
    expect(input[1]).toEqual({ role: 'assistant', content: '结果' });
  });

  it('无 encrypted_content 时只回传 id + summary，不伪造加密状态', () => {
    const { input } = toResponsesInput([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', id: 'rsn_2', summaryText: '简析' },
          { type: 'text', text: '结果' },
        ],
        generatedBy: { providerId: 'openai', modelId: 'gpt-5.2', protocol: 'openai-responses-llm' },
      },
    ], 'openai', 'gpt-5.2');

    expect(input[0]).toEqual({
      type: 'reasoning',
      id: 'rsn_2',
      summary: [{ type: 'summary_text', text: '简析' }],
    });
  });

  it('跨模型/跨 Provider 或无来源的 reasoning 不重放，text/tool_use 保留', () => {
    const { input } = toResponsesInput([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', id: 'rsn_x', summaryText: '旧模型思考' },
          { type: 'text', text: '结果' },
          { type: 'tool_use', id: 'c1', name: 'FileEdit', args: {} },
        ],
        generatedBy: { providerId: 'openai', modelId: 'gpt-5.2-mini', protocol: 'openai-responses-llm' },
      },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', id: 'rsn_y', summaryText: '网关B思考' },
          { type: 'text', text: '无思考' },
        ],
        generatedBy: { providerId: 'gateway-b', modelId: 'gpt-5.2', protocol: 'openai-responses-llm' },
      },
    ], 'openai', 'gpt-5.2');

    expect(input).toEqual([
      { role: 'assistant', content: '结果' },
      { type: 'function_call', id: 'c1', call_id: 'c1', name: 'FileEdit', arguments: '{}' },
      { role: 'assistant', content: '无思考' },
    ]);
  });
});
