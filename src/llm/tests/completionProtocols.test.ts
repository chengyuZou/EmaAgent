import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLLMCompletion } from '../languageModel.js';
import type { LLMProtocol, LLMRequest } from '../types.js';

const sdk = vi.hoisted(() => ({
  responses: vi.fn(),
  anthropic: vi.fn(),
  anthropicStream: vi.fn(),
  gemini: vi.fn(),
  geminiStream: vi.fn(),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({ responses: { create: sdk.responses } })),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: sdk.anthropic, stream: sdk.anthropicStream },
  })),
}));
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContent: sdk.gemini, generateContentStream: sdk.geminiStream },
  })),
  FunctionCallingConfigMode: { AUTO: 'AUTO', NONE: 'NONE', ANY: 'ANY' },
}));

const request: LLMRequest = {
  messages: [{ role: 'user', content: 'hello' }],
  tools: [{ name: 'Read', description: 'Read a file', inputSchema: { type: 'object' } }],
  maxOutputTokens: 4_096,
  thinking: { enabled: true, effort: 'low' },
};

function complete(protocol: LLMProtocol) {
  return createLLMCompletion({ providerId: 'test', protocol, apiKey: 'key' }, 'model');
}

beforeEach(() => {
  for (const mock of Object.values(sdk)) mock.mockReset();
});

describe('Responses 非流式结果', () => {
  it('按 output 顺序保留思考状态, 多段正文, 工具和缓存用量', async () => {
    sdk.responses.mockResolvedValueOnce({
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'reason-1', summary: [], encrypted_content: 'encrypted' },
        { type: 'message', content: [{ type: 'output_text', text: 'before' }] },
        { type: 'function_call', call_id: 'call-1', name: 'Read', arguments: '{"path":"a.txt"}' },
        { type: 'message', content: [{ type: 'output_text', text: 'after' }] },
      ],
      usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } },
    });
    await expect(complete('openai-responses-llm')(request)).resolves.toEqual({
      blocks: [
        { type: 'reasoning', id: 'reason-1', encryptedContent: 'encrypted' },
        { type: 'text', text: 'before' },
        { type: 'tool_use', id: 'call-1', name: 'Read', args: { path: 'a.txt' } },
        { type: 'text', text: 'after' },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 4 },
    });
    expect(sdk.responses).toHaveBeenCalledTimes(1);
    expect(sdk.responses.mock.calls[0]?.[0]).toMatchObject({
      stream: false,
      max_output_tokens: 4_096,
      reasoning: { effort: 'low' },
      include: ['reasoning.encrypted_content'],
    });
  });

  it('保留思考摘要和拒绝正文', async () => {
    sdk.responses.mockResolvedValueOnce({
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'reason-1', summary: [{ text: 'first' }, { text: 'second' }] },
        { type: 'message', content: [{ type: 'refusal', refusal: 'cannot help' }] },
      ],
    });
    await expect(complete('openai-responses-llm')(request)).resolves.toMatchObject({
      blocks: [
        { type: 'reasoning', id: 'reason-1', summaryText: 'firstsecond' },
        { type: 'text', text: 'cannot help' },
      ],
    });
  });

  it.each([
    ['max_output_tokens', 'max_tokens'],
    ['content_filter', 'stop_sequence'],
  ])('incomplete 的 %s 返回 %s', async (reason, stopReason) => {
    sdk.responses.mockResolvedValueOnce({ status: 'incomplete', incomplete_details: { reason }, output: [] });
    await expect(complete('openai-responses-llm')(request)).resolves.toMatchObject({ stopReason });
  });

  it('失败响应继续归一化上下文超限', async () => {
    sdk.responses.mockResolvedValueOnce({
      status: 'failed',
      error: { code: 'context_length_exceeded', message: 'context too long' },
    });
    await expect(complete('openai-responses-llm')(request))
      .rejects.toMatchObject({ name: 'ContextWindowExceededError' });
  });

  it('非终态不返回成功结果, 不轮询或补发请求', async () => {
    sdk.responses.mockResolvedValueOnce({ status: 'in_progress', output: [] });
    await expect(complete('openai-responses-llm')(request))
      .rejects.toMatchObject({ name: 'LLMProviderResponseError' });
    expect(sdk.responses).toHaveBeenCalledTimes(1);
  });

  it('工具参数不是合法 JSON 时拒绝结果', async () => {
    sdk.responses.mockResolvedValueOnce({
      status: 'completed',
      output: [{ type: 'function_call', call_id: 'bad', name: 'Read', arguments: '{' }],
    });
    await expect(complete('openai-responses-llm')(request))
      .rejects.toMatchObject({ name: 'LLMToolArgumentsParseError', callId: 'bad' });
  });
});

describe('Anthropic 非流式结果', () => {
  it('使用 messages.create, 保留签名和工具输入, 缓存用量计入总输入', async () => {
    sdk.anthropic.mockResolvedValueOnce({
      content: [
        { type: 'thinking', thinking: 'reason', signature: 'signature' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'a.txt' } },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 2,
      },
    });
    await expect(complete('anthropic-llm')(request)).resolves.toEqual({
      blocks: [
        { type: 'thinking', thinking: 'reason', signature: 'signature' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'call-1', name: 'Read', args: { path: 'a.txt' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 16, outputTokens: 5, cacheReadInputTokens: 4, cacheWriteInputTokens: 2 },
    });
    expect(sdk.anthropic).toHaveBeenCalledTimes(1);
    expect(sdk.anthropicStream).not.toHaveBeenCalled();
    expect(sdk.anthropic.mock.calls[0]?.[0]).toMatchObject({
      stream: false,
      max_tokens: 4_096,
      thinking: { type: 'enabled', budget_tokens: 2_000 },
      temperature: 1,
    });
    expect(sdk.anthropic.mock.calls[0]?.[1].headers)
      .toEqual({ 'anthropic-beta': 'interleaved-thinking-2025-05-14' });
  });

  it('缺少输出预算时不执行 SDK 请求', async () => {
    await expect(complete('anthropic-llm')({ messages: request.messages })).rejects.toThrow(/maxOutputTokens/);
    expect(sdk.anthropic).not.toHaveBeenCalled();
    expect(sdk.anthropicStream).not.toHaveBeenCalled();
  });

  it('输出达到上限时保留正文并报告 max_tokens', async () => {
    sdk.anthropic.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'partial' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 1, output_tokens: 4 },
    });
    await expect(complete('anthropic-llm')(request)).resolves.toMatchObject({
      blocks: [{ type: 'text', text: 'partial' }], stopReason: 'max_tokens',
    });
  });
});

describe('Gemini 非流式结果', () => {
  it('使用 generateContent, 保留内容顺序和 thoughtSignature, 累计思考用量', async () => {
    sdk.gemini.mockResolvedValueOnce({
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [
          { thought: true, text: 'reason', thoughtSignature: 'signature' },
          { text: 'before' },
          { functionCall: { id: 'call-1', name: 'Read', args: { path: 'a.txt' } } },
          { text: 'after' },
        ] },
      }],
      usageMetadata: {
        promptTokenCount: 10,
        toolUsePromptTokenCount: 2,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 3,
        cachedContentTokenCount: 4,
      },
    });
    await expect(complete('gemini-llm')(request)).resolves.toEqual({
      blocks: [
        { type: 'gemini_thought', text: 'reason', thoughtSignature: 'signature' },
        { type: 'text', text: 'before' },
        { type: 'tool_use', id: 'call-1', name: 'Read', args: { path: 'a.txt' } },
        { type: 'text', text: 'after' },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 12, outputTokens: 8, cacheReadInputTokens: 4 },
    });
    expect(sdk.gemini).toHaveBeenCalledTimes(1);
    expect(sdk.geminiStream).not.toHaveBeenCalled();
    expect(sdk.gemini.mock.calls[0]?.[0].config).toMatchObject({
      maxOutputTokens: 4_096,
      thinkingConfig: { includeThoughts: true, thinkingBudget: 2_000 },
    });
  });

  it('没有候选结果时拒绝, 不伪造 end_turn', async () => {
    sdk.gemini.mockResolvedValueOnce({ candidates: [] });
    await expect(complete('gemini-llm')(request))
      .rejects.toMatchObject({ name: 'LLMProviderResponseError', protocol: 'gemini-llm' });
  });

  it('调用期间取消后即使 SDK 交付结果也不返回成功', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    sdk.gemini.mockImplementationOnce(async () => {
      controller.abort(reason);
      return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'late' }] } }] };
    });
    await expect(complete('gemini-llm')({ ...request, signal: controller.signal })).rejects.toBe(reason);
    expect(sdk.gemini).toHaveBeenCalledTimes(1);
  });
});
