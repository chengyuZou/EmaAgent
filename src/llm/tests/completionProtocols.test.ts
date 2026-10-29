
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLLMCompletion } from '../languageModel.js';
import type { LLMProtocol } from '../types.js';

const sdk = vi.hoisted(() => ({
  responses: vi.fn(), anthropic: vi.fn(), anthropicStream: vi.fn(),
  gemini: vi.fn(), geminiStream: vi.fn(),
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

async function* stream(events: readonly unknown[]) { yield* events; }
const request = { messages: [{ role: 'user' as const, content: 'hello' }], maxOutputTokens: 64000 };
function complete(protocol: LLMProtocol) {
  return createLLMCompletion({ providerId: 'test', protocol, apiKey: 'test' }, 'model');
}
beforeEach(() => { for (const mock of Object.values(sdk)) mock.mockReset(); });

describe('CompleteLLM 内部流式收集', () => {
  it('Responses 保留交错正文、工具和加密思考的位置', async () => {
    sdk.responses.mockResolvedValueOnce(stream([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'reason' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'reason', encrypted_content: 'encrypted' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message' } },
      { type: 'response.output_text.delta', output_index: 1, delta: 'before' },
      { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'call', name: 'Read' } },
      { type: 'response.function_call_arguments.done', output_index: 2, arguments: '{"path":"a.txt"}' },
      { type: 'response.output_item.added', output_index: 3, item: { type: 'message' } },
      { type: 'response.output_text.delta', output_index: 3, delta: 'after' },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } } } },
    ]));
    await expect(complete('openai-responses-llm')(request)).resolves.toEqual({
      blocks: [
        { type: 'reasoning', id: 'reason', encryptedContent: 'encrypted' },
        { type: 'text', text: 'before' },
        { type: 'tool_use', id: 'call', name: 'Read', args: { path: 'a.txt' } },
        { type: 'text', text: 'after' },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 4 },
    });
    expect(sdk.responses.mock.calls[0]![0].stream).toBe(true);
  });

  it('Anthropic 大输出预算走 messages.stream, 保留签名和最终累计用量', async () => {
    sdk.anthropicStream.mockReturnValueOnce(stream([
      { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]));
    await expect(complete('anthropic-llm')(request)).resolves.toEqual({
      blocks: [{ type: 'thinking', thinking: 'reason', signature: 'signature' }, { type: 'text', text: 'answer' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 16, outputTokens: 5, cacheReadInputTokens: 4, cacheWriteInputTokens: 2 },
    });
    expect(sdk.anthropic).not.toHaveBeenCalled();
    expect(sdk.anthropicStream).toHaveBeenCalledOnce();
    expect(sdk.anthropicStream.mock.calls[0]![0].max_tokens).toBe(64000);
  });

  it('Gemini 保留 thoughtSignature、工具 ID 和工具前后的正文', async () => {
    sdk.geminiStream.mockResolvedValueOnce(stream([{
      candidates: [{ finishReason: 'STOP', content: { parts: [
        { thought: true, text: 'reason', thoughtSignature: 'signature' },
        { text: 'before' },
        { functionCall: { id: 'call', name: 'Read', args: {} } },
        { text: 'after' },
      ] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 },
    }]));
    await expect(complete('gemini-llm')(request)).resolves.toEqual({
      blocks: [
        { type: 'gemini_thought', text: 'reason', thoughtSignature: 'signature' },
        { type: 'text', text: 'before' },
        { type: 'tool_use', id: 'call', name: 'Read', args: {} },
        { type: 'text', text: 'after' },
      ],
      stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 8 },
    });
    expect(sdk.gemini).not.toHaveBeenCalled();
  });

  it('中途断流不返回半截结果', async () => {
    sdk.anthropicStream.mockReturnValueOnce(stream([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
    ]));
    await expect(complete('anthropic-llm')(request)).rejects.toMatchObject({ code: 'provider/incomplete_stream' });
  });

  it('供应商报告输出上限时保留内容和 max_tokens', async () => {
    sdk.anthropicStream.mockReturnValueOnce(stream([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]));
    await expect(complete('anthropic-llm')(request)).resolves.toMatchObject({
      blocks: [{ type: 'text', text: 'partial' }], stopReason: 'max_tokens',
    });
  });

  it('取消时关闭流, 不返回迟到内容', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel');
    const closed = vi.fn();
    sdk.geminiStream.mockResolvedValueOnce((async function* () {
      try {
        controller.abort(reason);
        yield { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'late' }] } }] };
      } finally { closed(); }
    })());
    await expect(complete('gemini-llm')({ ...request, signal: controller.signal })).rejects.toBe(reason);
    expect(closed).toHaveBeenCalledOnce();
  });
});
