// 测试 OpenAI Responses 协议的同模型 reasoning 重放裁决。
import { describe, expect, it } from 'vitest';
import { toResponsesInput } from '../protocols/openAiResponses.js';

describe('toResponsesInput reasoning 重放', () => {
  it('同模型生成的 thinking 重放为 reasoning item（summary 结构对齐）', () => {
    const { input } = toResponsesInput([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '分析步骤' },
          { type: 'text', text: '结果' },
        ],
        generatedBy: { providerId: 'openai', modelId: 'gpt-5.2', protocol: 'openai-responses-llm' },
      },
    ], 'gpt-5.2');

    expect(input).toHaveLength(2);
    expect(input[0]).toMatchObject({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: '分析步骤' }],
    });
    expect(typeof (input[0] as { id?: string }).id).toBe('string');
    expect(input[1]).toEqual({ role: 'assistant', content: '结果' });
  });

  it('跨模型或无来源的 thinking 不重放，text/tool_use 保留', () => {
    const { input } = toResponsesInput([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '旧模型思考' },
          { type: 'text', text: '结果' },
          { type: 'tool_use', id: 'c1', name: 'FileEdit', args: {} },
        ],
        generatedBy: { providerId: 'openai', modelId: 'gpt-5.2-mini', protocol: 'openai-responses-llm' },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '无思考' }],
      },
    ], 'gpt-5.2');

    expect(input).toEqual([
      { role: 'assistant', content: '结果' },
      { type: 'function_call', id: 'c1', call_id: 'c1', name: 'FileEdit', arguments: '{}' },
      { role: 'assistant', content: '无思考' },
    ]);
  });
});
