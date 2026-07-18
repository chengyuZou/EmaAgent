// 测试工具结果预览严格遵守 UTF-8 字节上限，并且不会切断中文或 emoji。
import { describe, expect, it } from 'vitest';
import { generatePreview } from '../src/tool-result.js';

describe('工具结果 UTF-8 预览', () => {
  it('按真实字节截断中文，不把字节上限误当字符数量', () => {
    const result = generatePreview('中文测试内容', 7);

    expect(result).toEqual({ preview: '中文', hasMore: true });
    expect(Buffer.byteLength(result.preview, 'utf8')).toBeLessThanOrEqual(7);
  });

  it('不会切断四字节 emoji', () => {
    const result = generatePreview('A😀B', 4);

    expect(result).toEqual({ preview: 'A', hasMore: true });
    expect(result.preview).not.toContain('�');
  });

  it('优先在预算后半段的完整换行处截断', () => {
    const result = generatePreview('第一行\n第二行很长', 17);

    expect(result).toEqual({ preview: '第一行', hasMore: true });
  });

  it('拒绝无法表达为安全字节上限的参数', () => {
    expect(() => generatePreview('text', -1)).toThrow(RangeError);
    expect(() => generatePreview('text', 1.5)).toThrow(RangeError);
  });
});
