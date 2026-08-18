// 测试原始图片内容块的模型能力适配：透传、Vision 描述降级与 URL 图片拒绝。
import { describe, expect, it } from 'vitest';
import type { ContentPart } from '@ema-agent/llm';
import { prepareImagesForModel, replaceImageParts } from '../preparation/mediaCompatibility.js';

const IMAGE: ContentPart = { type: 'image_data', data: 'aGVsbG8=', mimeType: 'image/png' };
const TEXT: ContentPart = { type: 'text', text: '看图' };

describe('prepareImagesForModel', () => {
  it('模型支持图片输入时原样透传', async () => {
    const result = await prepareImagesForModel([TEXT, IMAGE], true, {
      describeImage: async () => { throw new Error('不应被调用'); },
    });
    expect(result.parts).toEqual([TEXT, IMAGE]);
    expect(result.degradation).toBeUndefined();
  });

  it('不支持时替换为描述文本并记录降级；多图带序号', async () => {
    const result = await prepareImagesForModel([TEXT, IMAGE, IMAGE], false, {
      describeImage: async image => `描述:${image.data}`,
    });
    expect(result.parts).toHaveLength(2);
    expect(result.parts[0]).toEqual(TEXT);
    expect(result.parts[1]).toMatchObject({ type: 'text' });
    expect((result.parts[1] as { text: string }).text).toContain('### 图片 1');
    expect((result.parts[1] as { text: string }).text).toContain('### 图片 2');
    expect(result.degradation).toMatchObject({ removed: ['image'], replacements: ['description'] });
  });

  it('image_url 不支持时拒绝（不主动抓取）', async () => {
    const url: ContentPart = { type: 'image_url', url: 'https://x/y.png' };
    await expect(prepareImagesForModel([url], false, {
      describeImage: async () => 'x',
    })).rejects.toThrow(/URL 图片/);
  });

  it('replaceImageParts 只在首个图片位置插入一次替换块', () => {
    const output = replaceImageParts([IMAGE, TEXT, IMAGE], [{ type: 'text', text: 'D' }]);
    expect(output).toEqual([{ type: 'text', text: 'D' }, TEXT]);
  });
});
