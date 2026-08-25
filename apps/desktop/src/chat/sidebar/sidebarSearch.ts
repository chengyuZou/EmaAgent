// 侧栏会话搜索的本地排序与模糊评分,纯函数无 UI 依赖。
import type { SessionSearchItem, SessionWire } from '../../api/sessions.js';

export function rankSearchResults(query: string, results: SessionSearchItem[]): SessionSearchItem[] {
  return [...results].sort((a, b) => {
    const sb = scoreSearchItem(query, b);
    const sa = scoreSearchItem(query, a);
    if (sb !== sa) return sb - sa;
    return b.session.lastActivityAt - a.session.lastActivityAt;
  });
}

function scoreSearchItem(query: string, item: SessionSearchItem): number {
  return fuzzyScore(query, item.session.title) * 1.45
    + fuzzyScore(query, item.snippet) * (item.matchKind === 'message' ? 1.1 : 0.55)
    + (item.session.pinned ? 0.08 : 0);
}

function fuzzyScore(query: string, target: string): number {
  const q = normaliseSearchText(query);
  const t = normaliseSearchText(target);
  if (!q || !t) return 0;
  if (t === q) return 1;
  if (t.includes(q)) return 0.82 + Math.min(0.12, q.length / Math.max(t.length, 1));

  const subseq = subsequenceScore(q, t);
  const dice = diceCoefficient(q, t);
  return Math.max(subseq * 0.72, dice * 0.68);
}

function subsequenceScore(query: string, target: string): number {
  let qi = 0;
  let run = 0;
  let bestRun = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      qi++;
      run++;
      bestRun = Math.max(bestRun, run);
    } else {
      run = 0;
    }
  }
  if (qi !== query.length) return 0;
  return (query.length / target.length) * 0.55 + (bestRun / query.length) * 0.45;
}

function diceCoefficient(a: string, b: string): number {
  const aa = bigrams(a);
  const bb = bigrams(b);
  if (aa.length === 0 || bb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const x of aa) counts.set(x, (counts.get(x) ?? 0) + 1);
  let hits = 0;
  for (const x of bb) {
    const n = counts.get(x) ?? 0;
    if (n <= 0) continue;
    hits++;
    counts.set(x, n - 1);
  }
  return (2 * hits) / (aa.length + bb.length);
}

function bigrams(value: string): string[] {
  if (value.length <= 1) return value ? [value] : [];
  const out: string[] = [];
  for (let i = 0; i < value.length - 1; i++) out.push(value.slice(i, i + 2));
  return out;
}

function normaliseSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

export function toRecentSearchItem(session: SessionWire): SessionSearchItem {
  return {
    session,
    matchKind: 'title',
    snippet: '',
    messageId: null,
    messageAt: null,
  };
}
