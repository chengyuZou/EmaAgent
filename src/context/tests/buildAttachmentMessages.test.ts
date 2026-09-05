// 验证附件块 → 模型内容的规则表:文件/粘贴文本纯路径投影,图片的支持/降级/读失败分支,
// 以及取消信号原样上抛不伪装成降级。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAttachmentMessages } from '../buildAttachmentMessages.js';
import type { BuildAttachmentMessagesOptions } from '../buildAttachmentMessages.js';

const temporary: string[] = [];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ema-ctx-att-'));
  temporary.push(dir);
});

afterEach(() => {
  for (const target of temporary.splice(0)) rmSync(target, { recursive: true, force: true });
});

const signal = () => new AbortController().signal;

function options(partial: Partial<BuildAttachmentMessagesOptions>): BuildAttachmentMessagesOptions {
  return { supportsImageInput: true, signal: signal(), ...partial };
}

describe('buildAttachmentMessages', () => {
  it('file_reference → basename + 路径文本, 零 IO', async () => {
    const result = await buildAttachmentMessages(
      { type: 'file_reference', path: 'D:/docs/设计稿.pdf' },
      options({}),
    );
    expect(result).toEqual([{
      type: 'text',
      text: '[附件: 设计稿.pdf, 路径: D:/docs/设计稿.pdf]',
    }]);
  });

  it('pasted_text_reference → 路径 + 定格预览, 零 IO', async () => {
    const result = await buildAttachmentMessages(
      { type: 'pasted_text_reference', path: 'D:/data/pasted/a.txt', preview: '开头的五百字符' },
      options({}),
    );
    expect(result).toEqual([{
      type: 'text',
      text: '[粘贴文本: D:/data/pasted/a.txt]\n内容预览:\n开头的五百字符',
    }]);
  });

  it('image + 支持图片 → 带名标签文本 + image_data(扩展名判 mime)', async () => {
    const imagePath = path.join(dir, 'cat.png');
    writeFileSync(imagePath, Buffer.from('abc'));

    const result = await buildAttachmentMessages(
      { type: 'image_reference', path: imagePath, name: '猫.png' },
      options({}),
    );

    expect(result).toEqual([
      { type: 'text', text: `[图片: 猫.png, 路径: ${imagePath}]` },
      {
        type: 'image_data',
        data: Buffer.from('abc').toString('base64'),
        mimeType: 'image/png',
        name: '猫.png',
      },
    ]);
  });

  it('image + 支持图片 + 文件没了 → 系统提示文本, 不炸', async () => {
    const missing = path.join(dir, 'gone.png');
    const result = await buildAttachmentMessages(
      { type: 'image_reference', path: missing },
      options({}),
    );
    expect(result).toEqual([{
      type: 'text',
      text: `[系统提示: 这张图片的文件已不存在或无法读取, 路径: ${missing}]`,
    }]);
  });

  it('image + 不支持 + 缓存与生产者齐备 → 现做描述', async () => {
    const imagePath = path.join(dir, 'cat.png');
    writeFileSync(imagePath, Buffer.from('abc'));
    const getOrCreate = vi.fn(async () => '一只粉色的猫');
    const describeImage = vi.fn(async () => '一只粉色的猫');

    const result = await buildAttachmentMessages(
      { type: 'image_reference', path: imagePath },
      options({
        supportsImageInput: false,
        visionCache: { getOrCreate },
        describeImage,
      }),
    );

    expect(getOrCreate).toHaveBeenCalledWith(imagePath, expect.anything(), describeImage);
    expect(result[0]).toMatchObject({ type: 'text' });
    expect((result[0] as { text: string }).text).toContain('一只粉色的猫');
  });

  it('image + 不支持 + 未配置 Vision → 系统提示文本', async () => {
    const imagePath = path.join(dir, 'cat.png');
    const result = await buildAttachmentMessages(
      { type: 'image_reference', path: imagePath },
      options({ supportsImageInput: false }),
    );
    expect(result).toEqual([{
      type: 'text',
      text: `[系统提示: 用户附了一张图片, 当前模型不支持图片输入且未配置 Vision 模型, 路径: ${imagePath}]`,
    }]);
  });

  it('image + 不支持 + Vision 生产失败 → 生成失败的系统提示', async () => {
    const imagePath = path.join(dir, 'cat.png');
    const result = await buildAttachmentMessages(
      { type: 'image_reference', path: imagePath },
      options({
        supportsImageInput: false,
        visionCache: { getOrCreate: vi.fn(async () => { throw new Error('vision 超时'); }) },
        describeImage: vi.fn(),
      }),
    );
    expect(result).toEqual([{
      type: 'text',
      text: `[系统提示: 图片描述生成失败, 图片路径: ${imagePath}]`,
    }]);
  });

  it('取消信号原样上抛, 不伪装成降级', async () => {
    const controller = new AbortController();
    controller.abort();
    const imagePath = path.join(dir, 'cat.png');
    await expect(buildAttachmentMessages(
      { type: 'image_reference', path: imagePath },
      {
        supportsImageInput: false,
        visionCache: {
          getOrCreate: vi.fn(async () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
          }),
        },
        describeImage: vi.fn(),
        signal: controller.signal,
      },
    )).rejects.toThrow('aborted');
  });
});
