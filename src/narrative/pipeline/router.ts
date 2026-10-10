import type { CallLlm } from '@ema-agent/llm';
import type { NarrativeTimelineId } from '@ema-agent/storage';
import { z } from 'zod';
import { TIMELINES } from './constants.js';
import { completeQueryText, parseQueryJson } from './keywords.js';
import { ROUTER_PROMPT } from './prompts.js';

const timelineSchema = z.enum(TIMELINES);
const routesSchema = z.record(z.string(), z.unknown());

/** 全剧情摘要只决定查询哪些周目及各自的子问题. 所有模式都先路由, 不用摘要代替召回正文. */
export async function routeTimelines(
  query: string,
  callLlm: CallLlm,
  signal: AbortSignal,
): Promise<Map<NarrativeTimelineId, string>> {
  const normalized = query.trim();
  if (!normalized) {
    throw new TypeError('Narrative query must not be empty');
  }
  const text = await completeQueryText(callLlm, normalized, signal, ROUTER_PROMPT);
  const response = routesSchema.parse(parseQueryJson(text));
  const routes = new Map<NarrativeTimelineId, string>();
  // 未知周目使整次路由失败, 不静默查询其他周目; 非字符串或空子问题不执行.
  // Map 保留模型返回的周目顺序, 后续逐周目查询和最终结果沿用这个顺序.
  for (const [name, subquery] of Object.entries(response)) {
    const timeline = timelineSchema.parse(name);
    if (typeof subquery === 'string' && subquery.trim()) {
      routes.set(timeline, subquery.trim());
    }
  }
  if (routes.size === 0) {
    throw new Error('Narrative 路由没有生成可执行的子问题');
  }
  return routes;
}
