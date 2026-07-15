import { describe, expect, it } from 'vitest';
import { countWords } from './words.js';
import type { DocumentBlock } from './types.js';

function textBlock(text: string): DocumentBlock {
  return { kind: 'text', text } as DocumentBlock;
}

// B-080：之前 split(/\s+/) 对中文整段只算 1 词；Intl.Segmenter 按词分词。
describe('B-080 countWords 用 Intl.Segmenter 多语言分词', () => {
  it('中文按词分词,不再整段算 1 词', () => {
    const n = countWords([textBlock('我今天很高兴去了公园')]);
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThanOrEqual(10);
  });

  it('英文按空格分词', () => {
    expect(countWords([textBlock('hello world foo')])).toBe(3);
  });

  it('标点与空白不计入词数', () => {
    expect(countWords([textBlock('你好，世界！')])).toBe(2);
  });

  it('image block 跳过', () => {
    expect(countWords([{ kind: 'image', text: 'ignored' } as DocumentBlock])).toBe(0);
  });
});
