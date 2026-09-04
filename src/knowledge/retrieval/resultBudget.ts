// 检索结果的字符预算填充：按分数从高到低给全文，装不下即截断并报告。

import type { KbSearchHit } from '../types.js';

export interface BudgetedHits {
  readonly hits: KbSearchHit[];
  /** 预算耗尽时 true：还有命中未返回，调用方应如实告知而不是给残缺正文。 */
  readonly truncated: boolean;
}

/**
 * 放得下的命中保留全文；第一个放不下的命中起停止返回。
 * 不产出"看起来像结果但正文不完整"的对象。
 *
 * maxResultChars 未提供或小于等于 0 时不截断，truncated 恒为 false。
 */
export function applyResultBudget(
  hits: readonly KbSearchHit[],
  maxResultChars: number | undefined,
): BudgetedHits {
  if (!maxResultChars || maxResultChars <= 0) return { hits: [...hits], truncated: false };

  let remaining = maxResultChars;
  const out: KbSearchHit[] = [];
  for (const hit of hits) {
    if (hit.text.length > remaining) {
      return { hits: out, truncated: true };
    }
    out.push(hit);
    remaining -= hit.text.length;
  }
  return { hits: out, truncated: false };
}
