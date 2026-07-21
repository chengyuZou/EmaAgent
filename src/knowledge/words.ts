import type { DocumentBlock } from './types.js';

/**
 * 按"词"统计文档字数,用于 KB 文档列表展示与预算估算。
 *
 * 使用 Intl.Segmenter(Node 16+ 内置 ICU,V8 自带、零依赖、native 速度)按词粒度
 * 分词,支持中文/日文/英文等多语言——比 split(/\s+/) 准:中文无空格也能分词。
 * isWordLike 过滤标点与空白,只数真正的词。
 *
 * 之前用 split(/\s+/) 对中文整段只算 1 词(B-080);Segmenter 按 ICU 词库分词,
 * "我今天很高兴" → 我/今天/高兴 → 3 词。
 */
const wordSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });

export function countWords(blocks: DocumentBlock[]): number {
  let n = 0;
  for (const block of blocks) {
    if (block.kind === 'image') continue;
    for (const seg of wordSegmenter.segment(block.text)) {
      if (seg.isWordLike) n++;
    }
  }
  return n;
}
