import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { Message } from '@ema-agent/llm';
import { prepareMediaMessages } from '../prepareMediaMessages.js';

const signal = new AbortController().signal;
const image = (data: string) => ({ type: 'image_data' as const, data, mimeType: 'image/jpeg' });

describe('模型请求媒体预算', () => {
  it('附件和任意工具图片共同计数, 只省略旧媒体并保留原历史和调用配对', async () => {
    const messages: Message[] = [
      { role: 'user', content: [image('AAAA'), image('BBBB')] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'ObserveWindow', args: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: [image('CCCC'), image('DDDD')] }] },
    ];
    const original = structuredClone(messages);
    const result = await prepareMediaMessages(messages, { maxItems: 3, maxBytes: 100 }, signal);
    expect(messages).toEqual(original);
    expect(result).toHaveLength(messages.length);
    expect(result[0]).toMatchObject({ content: [{ type: 'text' }, image('BBBB')] });
    expect(result[2]).toEqual(messages[2]);
  });

  it('体积按编码后的字节累计, 数量未满也会省略旧图', async () => {
    const messages: Message[] = [{ role: 'user', content: [image('AAAA'), image('BBBB'), image('CCCC')] }];
    const result = await prepareMediaMessages(messages, { maxItems: 100, maxBytes: 8 }, signal);
    expect(result[0]).toMatchObject({ content: [{ type: 'text' }, image('BBBB'), image('CCCC')] });
    await expect(prepareMediaMessages(messages, { maxItems: 100, maxBytes: 3 }, signal))
      .rejects.toMatchObject({ code: 'provider/request_too_large' });
  });

  it('对普通附件 PNG 也编码发送副本, 不改变尺寸, 不修改原图', async () => {
    const pixels = Buffer.alloc(128 * 96 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 73 + (i >> 5)) % 256;
    const png = await sharp(pixels, { raw: { width: 128, height: 96, channels: 3 } }).png().toBuffer();
    const original = { type: 'image_data' as const, data: png.toString('base64'), mimeType: 'image/png' };
    const result = await prepareMediaMessages([{ role: 'user', content: [original] }], { maxItems: 100, maxBytes: 1024 * 1024 }, signal);
    const part = (result[0]!.content as readonly typeof original[])[0]!;
    const metadata = await sharp(Buffer.from(part.data, 'base64')).metadata();
    expect(metadata.width).toBe(128);
    expect(metadata.height).toBe(96);
    expect(part.data.length).toBeLessThanOrEqual(original.data.length);
    expect(original.mimeType).toBe('image/png');
  });
});
