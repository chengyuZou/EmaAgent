// 测试 Vision 把图片任务交给唯一 LLM 执行链，并保留输入校验、解析、Usage 与取消语义。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmRequest, LlmStreamEvent } from '@ema-agent/llm';
import { createVisionCall } from '../visionModel.js';

const llmMocks = vi.hoisted(() => ({
  createLlmCall: vi.fn(),
  requests: [] as LlmRequest[],
}));

vi.mock('@ema-agent/llm', async importOriginal => ({
  ...(await importOriginal<typeof import('@ema-agent/llm')>()),
  createLlmCall: llmMocks.createLlmCall,
}));

function stream(events: readonly LlmStreamEvent[]): AsyncIterable<LlmStreamEvent> {
  return (async function* () { yield* events; })();
}

describe('createVisionCall', () => {
  beforeEach(() => {
    llmMocks.requests.length = 0;
    llmMocks.createLlmCall.mockReset();
    llmMocks.createLlmCall.mockImplementation(() => (request: LlmRequest) => {
      llmMocks.requests.push(request);
      return stream([
        { type: 'text_delta', blockIndex: 0, delta: '{"text":"cat","blocks":[]}' },
        { type: 'usage', inputTokens: 12, outputTokens: 4 },
        { type: 'done', stopReason: 'end_turn' },
      ]);
    });
  });

  it('把视觉任务构造成一次无历史、无 Tool 的中立 LLM 请求', async () => {
    const connection = {
      providerId: 'p1',
      protocol: 'openai-llm' as const,
      apiKey: 'key',
      baseUrl: 'https://example.test/v1',
    };
    const vision = createVisionCall(connection, 'vision-model');

    await expect(vision({
      images: [{ kind: 'base64', data: ' YQ== ', mimeType: 'image/png' }],
      task: 'caption',
    })).resolves.toEqual({
      text: 'cat',
      blocks: [{ id: 'block-1', kind: 'text', text: 'cat' }],
      usage: { inputTokens: 12, outputTokens: 4 },
    });

    expect(llmMocks.createLlmCall).toHaveBeenCalledWith(connection, 'vision-model');
    expect(llmMocks.requests).toHaveLength(1);
    expect(llmMocks.requests[0]).toMatchObject({
      thinking: { enabled: false },
      maxOutputTokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'text' },
          { type: 'image_data', data: 'YQ==', mimeType: 'image/png' },
        ],
      }],
    });
    expect(llmMocks.requests[0]?.tools).toBeUndefined();
  });

  it('Anthropic 与 OpenAI Responses 直接复用对应 LLM protocol', () => {
    createVisionCall({ providerId: 'p', protocol: 'anthropic-llm' }, 'claude-test');
    createVisionCall({ providerId: 'p', protocol: 'openai-responses-llm' }, 'gpt-test');

    expect(llmMocks.createLlmCall.mock.calls.map(call => call[0].protocol))
      .toEqual(['anthropic-llm', 'openai-responses-llm']);
  });

  it('Gemini 对普通 HTTP 图片明确失败，不把不兼容 URL 交给协议层', async () => {
    const vision = createVisionCall(
      { providerId: 'p', protocol: 'gemini-llm', apiKey: 'key' },
      'gemini-test',
    );
    await expect(vision({
      images: [{ kind: 'url', url: 'https://example.test/image.png' }],
    })).rejects.toMatchObject({ code: 'vision/unsupported_input' });
    expect(llmMocks.requests).toHaveLength(0);
  });

  it('拒绝空模型、空图片与空载荷', async () => {
    expect(() => createVisionCall(
      { providerId: 'p', protocol: 'openai-llm' },
      ' ',
    )).toThrow(/model/i);
    const vision = createVisionCall({ providerId: 'p', protocol: 'openai-llm' }, 'model');
    await expect(vision({ images: [] }))
      .rejects.toMatchObject({ code: 'vision/invalid_request' });
    await expect(vision({
      images: [{ kind: 'bytes', bytes: new Uint8Array(), mimeType: 'image/png' }],
    })).rejects.toMatchObject({ code: 'vision/invalid_request' });
  });

  it('取消继续向上抛出，不包装成 Vision Provider 失败', async () => {
    const controller = new AbortController();
    const abortError = new Error('stop');
    llmMocks.createLlmCall.mockImplementationOnce(() => () => (async function* () {
      controller.abort(abortError);
      throw abortError;
    })());
    const vision = createVisionCall({ providerId: 'p', protocol: 'openai-llm' }, 'model');

    await expect(vision({
      images: [{ kind: 'base64', data: 'YQ==', mimeType: 'image/png' }],
      signal: controller.signal,
    })).rejects.toBe(abortError);
  });
});
