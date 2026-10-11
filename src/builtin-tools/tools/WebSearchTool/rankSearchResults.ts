import MiniSearch from 'minisearch';
import type { SearchResult } from './adapters/types.js';

const wordSegmenter = new Intl.Segmenter(['zh', 'ja', 'en'], { granularity: 'word' });

/** 只重排本次供应商返回的候选项, 不将分数解释成内容正确率. */
export function rankSearchResults(
  query: string,
  results: readonly SearchResult[],
): SearchResult[] {
  const index = new MiniSearch<SearchResult>({
    idField: 'url',
    fields: ['title', 'snippet'],
    tokenize: tokenizeSearchText,
  });
  index.addAll(results);

  // site 和布尔操作符用于找网页, 不应成为标题/摘要的匹配词.
  const contentQuery = query
    .replace(/(?:^|\s)-?site:\S+/giu, ' ')
    .replace(/\b(?:OR|AND|NOT)\b/gu, ' ');
  const scores = new Map<string, number>();
  for (const match of index.search(contentQuery)) {
    scores.set(String(match.id), match.score);
  }

  // sort 是稳定排序. 同分和未命中的项保留供应商顺序, 不随点击随机变化.
  return [...results].sort((left, right) =>
    (scores.get(right.url) ?? 0) - (scores.get(left.url) ?? 0),
  );
}

function tokenizeSearchText(text: string): string[] {
  const tokens: string[] = [];
  const parts = text.normalize('NFKC').matchAll(
    /[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*|[^A-Za-z0-9_]+/gu,
  );
  for (const part of parts) {
    const value = part[0];
    // 保留 Node.js、ERR_MODULE_NOT_FOUND、v22.3.0 等完整名称, 避免只匹配到通用单词.
    if (/^[A-Za-z0-9_]/u.test(value)) {
      tokens.push(value);
      continue;
    }
    for (const word of wordSegmenter.segment(value)) {
      if (word.isWordLike) {
        tokens.push(word.segment);
      }
    }
  }
  return tokens;
}
