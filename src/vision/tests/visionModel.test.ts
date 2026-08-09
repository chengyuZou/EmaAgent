// 测试 Vision 公共入口冻结协议连接、只执行一次请求并保留协议差异。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVisionModel } from '../visionModel.js';

const sdkMocks = vi.hoisted(() => ({
  openAiConstructor: vi.fn(),
  openAiCreate: vi.fn(),
  anthropicConstructor: vi.fn(),
  anthropicCreate: vi.fn(),
  geminiConstructor: vi.fn(),
  geminiGenerate: vi.fn(),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation((config: unknown) => {
    sdkMocks.openAiConstructor(config);
    return { chat: { completions: { create: sdkMocks.openAiCreate } } };
  }),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation((config: unknown) => {
    sdkMocks.anthropicConstructor(config);
    return { messages: { create: sdkMocks.anthropicCreate } };
  }),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation((config: unknown) => {
    sdkMocks.geminiConstructor(config);
    return { models: { generateContent: sdkMocks.geminiGenerate } };
  }),
}));

describe('createVisionModel', () => {
  beforeEach(() => {
    for (const mock of Object.values(sdkMocks)) mock.mockReset();
  });

  it('OpenAI 创建时关闭 SDK 重试并返回结构化结果', async () => {
    sdkMocks.openAiCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"text":"cat","blocks":[]}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    });
    const vision = createVisionModel({
      protocol: 'openai-vision',
      apiKey: 'key',
      baseUrl: 'https://example.test/v1',
    });

    await expect(vision.analyze({
      model: 'vision-model',
      images: [{ kind: 'base64', data: ' YQ== ', mimeType: 'image/png' }],
      task: 'caption',
    })).resolves.toEqual({
      text: 'cat',
      blocks: [{ id: 'block-1', kind: 'text', text: 'cat' }],
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    expect(sdkMocks.openAiConstructor).toHaveBeenCalledWith({
      apiKey: 'key',
      baseURL: 'https://example.test/v1',
      maxRetries: 0,
    });
    expect(sdkMocks.openAiCreate).toHaveBeenCalledTimes(1);
  });

  it('Anthropic 创建时关闭 SDK 重试', async () => {
    sdkMocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'plain description' }],
      usage: { input_tokens: 8, output_tokens: 2 },
    });
    const vision = createVisionModel({ protocol: 'anthropic-vision', apiKey: 'key' });

    await expect(vision.analyze({
      model: 'claude-test',
      images: [{ kind: 'bytes', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' }],
    })).resolves.toMatchObject({ text: 'plain description' });
    expect(sdkMocks.anthropicConstructor).toHaveBeenCalledWith({
      apiKey: 'key',
      baseURL: undefined,
      maxRetries: 0,
    });
  });

  it('Gemini 对普通 HTTP 图片明确失败，不静默漏图', async () => {
    const vision = createVisionModel({ protocol: 'gemini-vision', apiKey: 'key' });
    await expect(vision.analyze({
      model: 'gemini-test',
      images: [{ kind: 'url', url: 'https://example.test/image.png' }],
    })).rejects.toMatchObject({ code: 'vision/unsupported_input' });
    expect(sdkMocks.geminiGenerate).not.toHaveBeenCalled();
  });

  it('拒绝空模型、空图片与空载荷', async () => {
    const vision = createVisionModel({ protocol: 'openai-vision', apiKey: 'key' });
    await expect(vision.analyze({ model: '', images: [] }))
      .rejects.toMatchObject({ code: 'vision/invalid_request' });
    await expect(vision.analyze({
      model: 'model',
      images: [{ kind: 'bytes', bytes: new Uint8Array(), mimeType: 'image/png' }],
    })).rejects.toMatchObject({ code: 'vision/invalid_request' });
  });
});
