import { describe, expect, it, vi } from 'vitest';
import { LlmModelCapabilityError } from '@ema-agent/llm';
import type { ModelCapabilitySnapshot } from '@ema-agent/provider';
import {
  prepareImagesForModel,
  replaceImageParts,
  type MediaCompatibilityServices,
} from '../src/orchestrator/media-compatibility.js';

function capabilities(image: 'supported' | 'unsupported' | 'unknown'): ModelCapabilitySnapshot {
  return {
    input: { text: 'supported', image, audio: 'unknown', file: 'unknown' },
    tools: 'unknown',
    reasoning: 'unknown',
    temperature: 'unknown',
    source: image === 'unknown' ? 'unknown' : 'catalog',
  };
}

function services(
  image: 'supported' | 'unsupported' | 'unknown',
  overrides: Partial<MediaCompatibilityServices> = {},
): MediaCompatibilityServices {
  return {
    capabilitiesFor: () => capabilities(image),
    visionBinding: () => ({ providerConfigId: 'vision-provider', model: 'vision-model' }),
    describeImages: async () => '一只黑猫坐在窗边。',
    ...overrides,
  };
}

const imagePart = {
  type: 'image_data' as const,
  data: 'base64',
  mimeType: 'image/png',
  name: 'cat.png',
};

describe('Core 图片模型兼容协商', () => {
  it('当前 LLM 明确支持图片时原样透传，不调用 Vision', async () => {
    const describeImages = vi.fn<MediaCompatibilityServices['describeImages']>();
    const result = await prepareImagesForModel(
      services('supported', { describeImages }),
      'llm-provider',
      'vision-capable-model',
      [imagePart],
      new AbortController().signal,
    );

    expect(result.parts).toEqual([imagePart]);
    expect(result.parts[0]).not.toBe(imagePart);
    expect(result.degradation).toBeUndefined();
    expect(describeImages).not.toHaveBeenCalled();
  });

  it('当前 LLM 不支持图片时转换为描述并返回结构化降级信息', async () => {
    const describeImages = vi.fn(async () => '一只黑猫坐在窗边。');
    const result = await prepareImagesForModel(
      services('unsupported', { describeImages }),
      'llm-provider',
      'text-only-model',
      [imagePart],
      new AbortController().signal,
    );

    expect(describeImages).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'vision-provider',
      model: 'vision-model',
      inputs: [expect.objectContaining({ kind: 'base64', mimeType: 'image/png' })],
    }));
    expect(result.parts).toEqual([
      { type: 'text', text: expect.stringContaining('一只黑猫坐在窗边。') },
    ]);
    expect(result.degradation).toMatchObject({
      removed: ['image'],
      replacements: ['description'],
    });
  });

  it('能力未知且没有 Vision 绑定时 fail-closed', async () => {
    await expect(prepareImagesForModel(
      services('unknown', { visionBinding: () => undefined }),
      'llm-provider',
      'unknown-model',
      [imagePart],
      new AbortController().signal,
    )).rejects.toBeInstanceOf(LlmModelCapabilityError);
  });

  it('Vision 调用期间取消时保留原始取消原因', async () => {
    const controller = new AbortController();
    const abortError = new DOMException('用户停止', 'AbortError');
    controller.abort(abortError);

    await expect(prepareImagesForModel(
      services('unsupported', { describeImages: async () => { throw abortError; } }),
      'llm-provider',
      'text-only-model',
      [imagePart],
      controller.signal,
    )).rejects.toBe(abortError);
  });

  it('替换全部图片时保持非图片内容块的顺序', () => {
    expect(replaceImageParts(
      [{ type: 'text', text: '前' }, imagePart, { ...imagePart, name: 'second.png' }, { type: 'text', text: '后' }],
      [{ type: 'text', text: '图片描述' }],
    )).toEqual([
      { type: 'text', text: '前' },
      { type: 'text', text: '图片描述' },
      { type: 'text', text: '后' },
    ]);
  });
});
