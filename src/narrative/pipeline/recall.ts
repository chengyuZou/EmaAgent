import { setImmediate } from 'node:timers/promises';
import type { CallEmbed } from '@ema-agent/embed';
import type { CompleteLLM } from '@ema-agent/llm';
import type { CallRerank } from '@ema-agent/rerank';
import type { NarrativeChunksRepo, NarrativeGraphRepo, NarrativeTimelineId } from '@ema-agent/storage';
import { throwIfCancelled } from '../errors.js';
import type {
  NarrativeQueryMode,
  NarrativeRecallResult,
  NarrativeTimelineFailure,
  NarrativeTimelineResult,
} from '../types.js';
import { EMBEDDING_DIM, MAX_CONTEXT_CHARACTERS, RERANK_CANDIDATE_LIMIT, RERANK_TOP_K } from './constants.js';
import { buildContext } from './context.js';
import { embeddingTexts, queryTimeline } from './query.js';
import { extractKeywords, routeTimelines } from './router.js';

function timelineFailure(error: unknown): NarrativeTimelineFailure {
  return {
    message: error instanceof Error ? error.message : String(error),
  };
}

export class NarrativeSearch {
  // 向量及中间结果只属于一次 search, 不随实例缓存.
  constructor(
    private readonly chunks: NarrativeChunksRepo,
    private readonly graph: NarrativeGraphRepo,
  ) {}

  /**
   * completeLLM 并发执行独立的周目判断和提词请求. callEmbed 必须使用资产原有的 Pro/bge-m3 向量空间.
   * 重排比较传入的完整 query 和原文块, 不使用关键词替代 query, 不比较不同周目的分数.
   * 返回各周目的证据, 不生成最终回答. 宿主负责调用配置及用量记录.
   */
  async search(
    query: string,
    mode: NarrativeQueryMode,
    completeLLM: CompleteLLM,
    callEmbed: CallEmbed,
    callRerank: CallRerank,
    signal: AbortSignal,
  ): Promise<NarrativeRecallResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new TypeError('Narrative query must not be empty');
    }
    // 两条请求不交换内容. 任一失败则停止本次检索, 不使用旧路由或猜测的关键词补位.
    const [timelines, keywords] = await Promise.all([
      routeTimelines(normalizedQuery, completeLLM, signal),
      extractKeywords(normalizedQuery, completeLLM, signal),
    ]);
    signal.throwIfAborted();
    const texts = new Set(embeddingTexts(normalizedQuery, mode, keywords));
    const embeddings = new Map<string, Float32Array>();
    let embeddingFailure: NarrativeTimelineFailure | undefined;
    if (texts.size > 0) {
      try {
        signal.throwIfAborted();
        const inputs = [...texts];
        const embedded = await callEmbed({ texts: inputs, signal });
        signal.throwIfAborted();
        if (embedded.dim !== EMBEDDING_DIM) {
          throw new RangeError(`Narrative 需要 ${EMBEDDING_DIM} 维向量, 当前返回 ${embedded.dim} 维`);
        }
        for (let index = 0; index < inputs.length; index++) {
          embeddings.set(inputs[index]!, Float32Array.from(embedded.embeddings[index]!));
        }
      } catch (error) {
        throwIfCancelled(error, signal);
        embeddingFailure = timelineFailure(error);
      }
    }

    // 各周目各有返回预算, 不让某一周目的高分文档挤掉其他周目.
    const characterLimit = Math.floor(MAX_CONTEXT_CHARACTERS / timelines.length);
    const entries = await Promise.all(timelines.map(async timeline => {
      signal.throwIfAborted();
      if (embeddingFailure && texts.size > 0) {
        return [timeline, embeddingFailure] as const;
      }
      try {
        // SQL 和向量计算仍在同一线程轮流执行; 等待调度时可以响应取消.
        await setImmediate(undefined, { signal });
        const candidates = queryTimeline(
          timeline, normalizedQuery, mode, keywords, embeddings, this.chunks, this.graph, signal,
        ).slice(0, RERANK_CANDIDATE_LIMIT);
        if (candidates.length === 0) {
          return [timeline, { text: '' }] as const;
        }
        const ranked = await callRerank({
          query: normalizedQuery,
          documents: candidates.map(chunk => chunk.content),
          topK: Math.min(RERANK_TOP_K, candidates.length),
          signal,
        });
        signal.throwIfAborted();
        const selected = ranked.results.map(item => candidates[item.index]!);
        return [timeline, { text: buildContext(selected, characterLimit) }] as const;
      } catch (error) {
        throwIfCancelled(error, signal);
        return [timeline, timelineFailure(error)] as const;
      }
    }));
    return new Map<NarrativeTimelineId, NarrativeTimelineResult>(entries);
  }
}
