import type { CompleteLLM } from '@ema-agent/llm';
import type { NarrativeTimelineId } from '@ema-agent/storage';
import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';
import type { NarrativeKeywords } from '../types.js';
import { TIMELINES } from './constants.js';
import { buildKeywordExtractionPrompt, ROUTER_PROMPT } from './prompts.js';

const timelinesSchema = z.object({
  timelines: z.array(z.enum(TIMELINES)).min(1)
    .refine(value => new Set(value).size === value.length, 'Narrative 周目不能重复'),
}).strict();
const keywordsSchema = z.object({
  high_level_keywords: z.array(z.string().trim().min(1)),
  low_level_keywords: z.array(z.string().trim().min(1)),
}).strict();

// 部分文本协议把思考标签放进正文. 这里只修复 JSON 格式, 字段仍由 Schema 检查.
export function parseQueryJson(text: string): unknown {
  const withoutThinking = text
    .replace(/^((?!<think>).)*?<\/think>/s, '')
    .replace(/<think>.*?<\/think>/gs, '')
    .trim();
  return JSON.parse(jsonrepair(withoutThinking)) as unknown;
}

/** query 已由调用方清理首尾空白并检查非空. 剧情摘要只用于选择周目. */
export async function routeTimelines(
  query: string,
  completeLLM: CompleteLLM,
  signal: AbortSignal,
): Promise<NarrativeTimelineId[]> {
  signal.throwIfAborted();
  const completion = await completeLLM({
    messages: [
      { role: 'system', content: ROUTER_PROMPT },
      { role: 'user', content: query },
    ],
    temperature: 0.2,
    signal,
  });
  signal.throwIfAborted();
  const text = completion.blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
  return timelinesSchema.parse(parseQueryJson(text)).timelines;
}

// TODO: 原版提词仍会把 query 中明确排除的处刑或真结局提成正向关键词, 需要单独验证否定处理.
/** query 与周目请求共用调用方已清理的值, 但不发送剧情摘要或另一条请求的结果. */
export async function extractKeywords(
  query: string,
  completeLLM: CompleteLLM,
  signal: AbortSignal,
): Promise<NarrativeKeywords> {
  signal.throwIfAborted();
  const completion = await completeLLM({
    messages: [{ role: 'user', content: buildKeywordExtractionPrompt(query) }],
    temperature: 0.2,
    signal,
  });
  signal.throwIfAborted();
  const text = completion.blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
  const response = keywordsSchema.parse(parseQueryJson(text));
  return {
    highLevelKeywords: response.high_level_keywords,
    lowLevelKeywords: response.low_level_keywords,
  };
}
