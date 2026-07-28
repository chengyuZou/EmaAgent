// 测试图片输入按冻结模型能力原样透传或通过 Vision 描述安全降级。

import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import { LlmModelCapabilityError } from '@ema-agent/llm';
import type { ModelCapabilitySnapshot } from '@ema-agent/provider';
import { DEFAULT_ATTACHMENT_SETTINGS } from '@ema-agent/attachment';
import {
  prepareImagesForModel,
  replaceImageParts,
  type MediaCompatibilityServices,
} from '../mediaCompatibility.js';

const identity = {
  sessionId: asSessionId('session-1'),
  turnId: asTurnId('turn-1'),
};

function capabilities(image: 'supported' | 'unsupported' | 'unknown'): ModelCapabilitySnapshot {
  return {
    input: { text: 'supported', image, audio: 'unknown', file: 'unknown' },
    tools: 'unknown',
    reasoning: 'unknown',
    temperature: 'unknown',
    source: image === 'unknown' ? 'unknown' : 'catalog',
  };
}

function model(image: 'supported' | 'unsupported' | 'unknown') {
  return {
    providerId: 'llm-provider',
    model: image === 'supported' ? 'vision-capable-model' : 'text-only-model',
    capabilities: capabilities(image),
  };
}

function services(
  overrides: Partial<MediaCompatibilityServices> = {},
): MediaCompatibilityServices {
  return {
    visionBinding: () => ({
      providerConfigId: 'vision-provider',
      model: 'vision-model',
    }),
    describeImage: async () => '一只黑猫坐在窗边。',
    ...overrides,
  };
}

const imagePart = {
  type: 'image_data' as const,
  data: 'base64',
  mimeType: 'image/png',
  name: 'cat.png',
};

describe('根 Turn 图片模型兼容协商', () => {
  it('当前 LLM 明确支持图片时原样透传，不调用 Vision', async () => {
    const describeImage = vi.fn<MediaCompatibilityServices['describeImage']>();
    const result = await prepareImagesForModel(
      services({ describeImage }),
      model('supported'),
      [imagePart],
      identity,
      DEFAULT_ATTACHMENT_SETTINGS,
      new AbortController().signal,
    );

    expect(result.parts).toEqual([imagePart]);
    expect(result.parts[0]).not.toBe(imagePart);
    expect(result.degradation).toBeUndefined();
    expect(describeImage).not.toHaveBeenCalled();
  });

  it('当前 LLM 不支持图片时转换为描述并返回结构化降级信息', async () => {
    const describeImage = vi.fn(async () => '一只黑猫坐在窗边。');
    const result = await prepareImagesForModel(
      services({ describeImage }),
      model('unsupported'),
      [imagePart],
      identity,
      DEFAULT_ATTACHMENT_SETTINGS,
      new AbortController().signal,
    );

    expect(describeImage).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'vision-provider',
      model: 'vision-model',
      image: expect.objectContaining({ mimeType: 'image/png' }),
      ...identity,
    }));
    expect(result.parts).toEqual([
      { type: 'text', text: expect.stringContaining('一只黑猫坐在窗边。') },
    ]);
    expect(result.degradation).toMatchObject({
      removed: ['image'],
      replacements: ['description'],
    });
  });

  it('多张图片逐张描述并按原始顺序合并', async () => {
    const describeImage = vi.fn(async ({ image }: Parameters<
      MediaCompatibilityServices['describeImage']
    >[0]) => image.name === 'cat.png' ? '猫' : '狗');
    const result = await prepareImagesForModel(
      services({ describeImage }),
      model('unsupported'),
      [imagePart, { ...imagePart, name: 'dog.png' }],
      identity,
      DEFAULT_ATTACHMENT_SETTINGS,
      new AbortController().signal,
    );

    expect(describeImage).toHaveBeenCalledTimes(2);
    expect(result.parts[0]).toEqual({
      type: 'text',
      text: expect.stringMatching(/图片 1[\s\S]*猫[\s\S]*图片 2[\s\S]*狗/),
    });
  });

  it('能力未知且没有 Vision 绑定时 fail-closed', async () => {
    await expect(prepareImagesForModel(
      services({ visionBinding: () => undefined }),
      model('unknown'),
      [imagePart],
      identity,
      DEFAULT_ATTACHMENT_SETTINGS,
      new AbortController().signal,
    )).rejects.toBeInstanceOf(LlmModelCapabilityError);
  });

  it('Vision 调用期间取消时保留原始取消原因', async () => {
    const controller = new AbortController();
    const abortError = new DOMException('用户停止', 'AbortError');
    controller.abort(abortError);

    await expect(prepareImagesForModel(
      services({ describeImage: async () => { throw abortError; } }),
      model('unsupported'),
      [imagePart],
      identity,
      DEFAULT_ATTACHMENT_SETTINGS,
      controller.signal,
    )).rejects.toBe(abortError);
  });

  it('替换全部图片时保持非图片内容块的顺序', () => {
    expect(replaceImageParts(
      [
        { type: 'text', text: '前' },
        imagePart,
        { ...imagePart, name: 'second.png' },
        { type: 'text', text: '后' },
      ],
      [{ type: 'text', text: '图片描述' }],
    )).toEqual([
      { type: 'text', text: '前' },
      { type: 'text', text: '图片描述' },
      { type: 'text', text: '后' },
    ]);
  });
});
