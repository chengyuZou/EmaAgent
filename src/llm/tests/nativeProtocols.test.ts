// 测试 Anthropic 与 Gemini 原生协议都经公共入口产生显式完成流。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLlmCall } from '../languageModel.js';
import type { LlmStreamEvent } from '../types.js';

const sdkMocks = vi.hoisted(() => ({
  anthropicConstructor: vi.fn(),
  anthropicStream: vi.fn(),
  geminiConstructor: vi.fn(),
  geminiStream: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation((config: unknown) => {
    sdkMocks.anthropicConstructor(config);
    return { messages: { stream: sdkMocks.anthropicStream } };
  }),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation((config: unknown) => {
    sdkMocks.geminiConstructor(config);
    return { models: { generateContentStream: sdkMocks.geminiStream } };
  }),
  FunctionCallingConfigMode: { AUTO: 'AUTO', NONE: 'NONE', ANY: 'ANY' },
}));

async function* streamOf(items: readonly unknown[]): AsyncIterable<unknown> {
  for (const item of items) yield item;
}

async function collectText(stream: AsyncIterable<{ type: string; delta?: string }>): Promise<string> {
  let text = '';
  for await (const event of stream) {
    if (event.type === 'text_delta') text += event.delta ?? '';
  }
  return text;
}

describe('native LLM protocols', () => {
  beforeEach(() => {
    for (const mock of Object.values(sdkMocks)) mock.mockReset();
  });

  it('Anthropic 关闭 SDK 重试并要求调用级输出预算', async () => {
    sdkMocks.anthropicStream.mockReturnValueOnce(streamOf([
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'claude' },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]));
    const llm = createLlmCall({ providerId: 'test', protocol: 'anthropic-llm', apiKey: 'key' }, 'claude-test');

    await expect(collectText(llm({
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 128,
    }))).resolves.toBe('claude');
    expect(sdkMocks.anthropicConstructor).toHaveBeenCalledWith({
      apiKey: 'key',
      baseURL: undefined,
      maxRetries: 0,
    });
  });

  it('Gemini thought part 产生 thinking_delta 与带 thoughtSignature 的 thinking_complete', async () => {
    sdkMocks.geminiStream.mockResolvedValueOnce(streamOf([
      {
        candidates: [{
          content: { parts: [
            { text: '推理过程', thought: true, thoughtSignature: 'ts-1' },
            { text: '可见回答' },
          ] },
          finishReason: 'STOP',
        }],
      },
    ]));
    const llm = createLlmCall({ providerId: 'test', protocol: 'gemini-llm', apiKey: 'key' }, 'gemini-test');

    const events: LlmStreamEvent[] = [];
    for await (const event of llm({
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 128,
    })) {
      events.push(event);
    }

    expect(events.filter(event => event.type === 'thinking_delta')).toHaveLength(1);
    expect(events.find(event => event.type === 'thinking_complete')).toEqual({
      type: 'thinking_complete',
      blockIndex: 0,
      state: { kind: 'gemini', thoughtSignature: 'ts-1' },
    });
    expect(events.find(event => event.type === 'text_delta')?.delta).toBe('可见回答');
  });

  it('Gemini 原生协议保留 Google 流并产生明确终态', async () => {
    sdkMocks.geminiStream.mockResolvedValueOnce(streamOf([{
      candidates: [{
        content: { parts: [{ text: 'gemini' }] },
        finishReason: 'STOP',
      }],
    }]));
    const llm = createLlmCall({ providerId: 'test', protocol: 'gemini-llm', apiKey: 'key' }, 'gemini-test');

    await expect(collectText(llm({
      messages: [{ role: 'user', content: 'hello' }],
    }))).resolves.toBe('gemini');
    expect(sdkMocks.geminiConstructor).toHaveBeenCalledWith({ apiKey: 'key' });
  });
});
