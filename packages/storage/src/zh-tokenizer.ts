// FTS5 中文分词(RAGFlow 风格:先分词,再对词做 BM25)。
//
// jieba 的通用 dict(@node-rs/jieba/dict)是 RAGFlow trie dict 的可移植等价物。
// 索引时将 chunk 文本分词为空格连接的 `tokens` 字符串,FTS5 按词索引;
// 查询时同样分词,使 2 字中文词能命中(trigram 的 3 字窗口做不到)。
// Latin/ASCII 连续段由 jieba 原样保留。
//
// native module + dict 在首次使用时懒加载并缓存。若 native 二进制不可用
// (如平台不支持),降级为原始文本,FTS 仍可工作(Latin),而非抛异常。

import { Jieba } from '@node-rs/jieba';
// 显式 .js:@node-rs/jieba 无 package `exports` map,ESM 子路径解析不会自动补扩展名。
import { dict } from '@node-rs/jieba/dict.js';

let _jieba: Jieba | null | undefined;

function getJieba(): Jieba | null {
  if (_jieba !== undefined) return _jieba;
  try {
    _jieba = Jieba.withDict(dict);
  } catch (err) {
    console.warn('[storage] @node-rs/jieba unavailable, FTS falls back to raw text:',
      err instanceof Error ? err.message : err);
    _jieba = null;
  }
  return _jieba;
}

/**
 * 将文本分词为空格连接的 token 字符串,供 FTS 索引/查询。
 * jieba 不可用时返回原始文本(仅做空格归一化)。
 */
export function segmentForFts(text: string): string {
  if (!text.trim()) return '';
  const j = getJieba();
  if (!j) return text.replace(/\s+/g, ' ').trim();
  return j.cut(text, true).filter(t => t.trim()).join(' ');
}
