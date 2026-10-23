import type { CompleteLLM } from '@ema-agent/llm';
import type { NarrativeTimelineId } from '@ema-agent/storage';
import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';
import type { NarrativeRoute } from '../types.js';
import { TIMELINES } from './constants.js';
import { ROUTER_PROMPT } from './prompts.js';

const routeSchema = z.object({
  query: z.string().trim().min(1),
  high_level_keywords: z.array(z.string().trim().min(1)),
  low_level_keywords: z.array(z.string().trim().min(1)),
}).strict();
const routesSchema = z.partialRecord(z.enum(TIMELINES), routeSchema)
  .refine(value => Object.keys(value).length > 0, 'Narrative 路由没有生成可执行的子问题');

// 部分文本协议把思考标签放进正文. 这里只修复 JSON 格式, 字段仍由 Schema 检查.
export function parseQueryJson(text: string): unknown {
  const withoutThinking = text
    .replace(/^((?!<think>).)*?<\/think>/s, '')
    .replace(/<think>.*?<\/think>/gs, '')
    .trim();
  return JSON.parse(jsonrepair(withoutThinking)) as unknown;
}

// TODO: 当前路由将周目选择, 问题改写和关键词提取合并, 提词还会读取剧情摘要.
// 生成的子问题用于来源选块, 原 Tool query 用于重排, 可能导致两阶段关注不同内容.
// 尚未验证拆分周目选择并按 LightRAG 原文独立提词的效果.
// 具体差异和已有验证见 docs/testing/lightragExtractionAudit.md.

/** 一次调用确定周目, 子问题和关键词. 摘要只用于定位, 不替代原文证据. */
export async function routeTimelines(
  query: string,
  completeLLM: CompleteLLM,
  signal: AbortSignal,
): Promise<Map<NarrativeTimelineId, NarrativeRoute>> {
  const normalized = query.trim();
  if (!normalized) {
    throw new TypeError('Narrative query must not be empty');
  }
  signal.throwIfAborted();
  const completion = await completeLLM({
    messages: [
      { role: 'system', content: ROUTER_PROMPT },
      { role: 'user', content: normalized },
    ],
    temperature: 0.2,
    signal,
  });
  signal.throwIfAborted();
  const text = completion.blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
  const response = routesSchema.parse(parseQueryJson(text));
  const routes = new Map<NarrativeTimelineId, NarrativeRoute>();
  for (const [name, route] of Object.entries(response)) {
    routes.set(name as NarrativeTimelineId, {
      query: route.query,
      highLevelKeywords: route.high_level_keywords,
      lowLevelKeywords: route.low_level_keywords,
    });
  }
  return routes;
}
