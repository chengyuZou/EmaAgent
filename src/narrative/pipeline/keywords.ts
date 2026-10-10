import { createHash } from 'node:crypto';
import type { CallLlm, Message } from '@ema-agent/llm';
import { createLlmCompletion } from '@ema-agent/llm';
import type { NarrativeKeywordCacheRepo, NarrativeKeywords } from '@ema-agent/storage';
import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';
import type { NarrativeQueryMode } from '../types.js';
import { EMPTY_KEYWORDS_QUERY_LIMIT, KEYWORD_LANGUAGE } from './constants.js';
import { keywordPrompt } from './prompts.js';

const keywordsSchema = z.object({
  high_level_keywords: z.array(z.string()).default([]),
  low_level_keywords: z.array(z.string()).default([]),
});

/** 只用于查询前的路由/提词. systemPrompt 由剧情路由传入, 提词直接发送完整的用户 Prompt. */
export async function completeQueryText(
  callLlm: CallLlm,
  prompt: string,
  signal: AbortSignal,
  systemPrompt?: string,
): Promise<string> {
  signal.throwIfAborted();
  const messages: Message[] = [];
  if (systemPrompt !== undefined) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });
  const completion = await createLlmCompletion(callLlm({
    messages,
    signal,
    // 路由使用低温度减少周目分配变化, 提词不覆盖调用方的温度配置.
    ...(systemPrompt !== undefined ? { temperature: 0.2 } : {}),
  }));
  signal.throwIfAborted();
  // 思考块不是模型交付的 JSON 结果, 不与正文拼接后交给 JSON 解析器.
  return completion.blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
}

// 部分文本协议把思考标签放进正文, 先去掉完整思考段再修复 JSON 格式.
// 修复只处理格式, 具体字段仍由路由/提词各自的 Schema 检查.
export function parseQueryJson(text: string): unknown {
  const withoutThinking = text
    .replace(/^((?!<think>).)*?<\/think>/s, '')
    .replace(/<think>.*?<\/think>/gs, '')
    .trim();
  return JSON.parse(jsonrepair(withoutThinking)) as unknown;
}

export async function extractKeywords(
  query: string,
  mode: NarrativeQueryMode,
  cache: NarrativeKeywordCacheRepo,
  callLlm: CallLlm,
  signal: AbortSignal,
): Promise<NarrativeKeywords> {
  signal.throwIfAborted();
  // 原生键只使用模式、问题和提词语言的直接拼接; 不包含模型或供应商, 不缓存最终检索文本.
  const hash = createHash('md5').update(mode + query + KEYWORD_LANGUAGE, 'utf8').digest('hex');
  const cacheKey = `${mode}:keywords:${hash}`;
  const cached = cache.findByKey(cacheKey);
  let keywords = cached;
  if (!keywords) {
    const text = await completeQueryText(callLlm, keywordPrompt(query, KEYWORD_LANGUAGE), signal);
    let parsed: z.infer<typeof keywordsSchema>;
    try {
      parsed = keywordsSchema.parse(parseQueryJson(text));
    } catch {
      parsed = { high_level_keywords: [], low_level_keywords: [] };
    }
    keywords = {
      // 高层词是主题/事件, 用于查关系; 低层词是人物等具体名称, 用于查实体.
      highLevelKeywords: parsed.high_level_keywords,
      lowLevelKeywords: parsed.low_level_keywords,
    };
    if (keywords.highLevelKeywords.length > 0 || keywords.lowLevelKeywords.length > 0) {
      signal.throwIfAborted();
      // 成功提词后即保存两组数组, 后续召回失败或取消不会撤销这次缓存写入.
      cache.upsert(cacheKey, keywords.highLevelKeywords, keywords.lowLevelKeywords);
    }
  }
  // 原生短问题在没有关键词时使用原问题, 这个临时替代结果不写进缓存; 此处按 Unicode 字符计数.
  if (keywords.highLevelKeywords.length === 0 && keywords.lowLevelKeywords.length === 0
    && [...query].length < EMPTY_KEYWORDS_QUERY_LIMIT) {
    return { highLevelKeywords: [], lowLevelKeywords: [query] };
  }
  return keywords;
}
