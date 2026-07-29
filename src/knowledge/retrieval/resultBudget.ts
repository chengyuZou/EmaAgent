// 检索结果的字符预算填充：高分命中给全文，预算耗尽后降级为引用卡。

import type { KbSearchHit } from '../types.js';

/**
 * 按分数从高到低消耗预算：放得下的命中保留全文；第一个放不下的起，
 * 它与其后所有命中降级为 citation-only——只保留出处与命中块预览，
 * 让模型知道"这份文件还有内容"，可以如实告知用户或缩小范围重查。
 *
 * maxResultChars 未提供或小于等于 0 时原样返回，调用方行为零变化。
 */
export function applyResultBudget(
  hits: readonly KbSearchHit[],
  maxResultChars: number | undefined,
): KbSearchHit[] {
  if (!maxResultChars || maxResultChars <= 0) return [...hits];

  let remaining = maxResultChars;
  let exhausted = false;
  const out: KbSearchHit[] = [];
  for (const hit of hits) {
    if (!exhausted && hit.text.length <= remaining) {
      out.push(hit);
      remaining -= hit.text.length;
      continue;
    }
    exhausted = true;
    if (hit.citationOnly) {
      out.push(hit);
      continue;
    }
    out.push({
      chunkId: hit.chunkId,
      text: hit.source.chunkPreview,
      score: hit.score,
      source: hit.source,
      citationOnly: true,
    });
  }
  return out;
}
