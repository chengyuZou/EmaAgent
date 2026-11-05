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
import { EMBEDDING_DIM, MAX_CHUNK_CHARACTERS, RERANK_CANDIDATE_LIMIT, RERANK_TOP_K } from './constants.js';
import { selectChunksWithinBudget } from './chunkBudget.js';
import { collectEmbeddingTexts, queryTimeline } from './query.js';
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
   * completeLLM 并发执行独立的周目判断和提词请求. callEmbed 必须使用资产原有的 Pro/BAAI/bge-m3 向量空间.
   * 重排比较传入的完整 query 和原文块, 不使用关键词替代 query, 不比较不同周目的分数.
   * 返回各周目的证据, 不生成最终回答. Server 负责提供模型调用并记录用量.
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
    // mode 只用于选择需要编码的文本, 不会加入返回的字符串.
    const texts = new Set(collectEmbeddingTexts(normalizedQuery, mode, keywords));
    const embeddings = new Map<string, Float32Array>();
    let embeddingFailure: NarrativeTimelineFailure | undefined;
    if (texts.size > 0) {
      try {
        signal.throwIfAborted();
        const inputs = [...texts];
        // 一次请求分别编码各段文本. 相同文本已经去重, 不会重复请求向量.
        const embedded = await callEmbed({ texts: inputs, signal });
        signal.throwIfAborted();
        if (embedded.dim !== EMBEDDING_DIM) {
          throw new RangeError(`Narrative 需要 ${EMBEDDING_DIM} 维向量, 当前返回 ${embedded.dim} 维`);
        }
        // embedded.embeddings[i] 对应 inputs[i]. 以后按原文本取出向量,
        // 让三个周目的检索共用结果, 不再逐周目调用 Embedding.
        for (let index = 0; index < inputs.length; index++) {
          embeddings.set(inputs[index]!, Float32Array.from(embedded.embeddings[index]!));
        }
      } catch (error) {
        throwIfCancelled(error, signal);
        embeddingFailure = timelineFailure(error);
      }
    }

    // 原文预算由选中的周目均分. 图描述单独保留, 不挤占原文的名额.
    const characterLimit = Math.floor(MAX_CHUNK_CHARACTERS / timelines.length);
    const entries = await Promise.all(timelines.map(async timeline => {
      signal.throwIfAborted();
      if (embeddingFailure && texts.size > 0) {
        return [timeline, embeddingFailure] as const;
      }
      try {
        // SQL 和向量计算仍在同一线程轮流执行; 等待调度时可以响应取消.
        await setImmediate(undefined, { signal });
        const { entities, relations, chunks: candidateChunks } = queryTimeline(
          timeline,
          normalizedQuery,
          mode,
          keywords,
          embeddings,
          this.chunks,
          this.graph,
          signal,
        );

        // Rerank 只处理原文候选. 没有原文时, 仍返回已经查到的节点和边.
        const rerankCandidates = candidateChunks.slice(0, RERANK_CANDIDATE_LIMIT);
        if (rerankCandidates.length === 0) {
          return [timeline, { entities, relations, chunks: [] }] as const;
        }
        const ranked = await callRerank({
          query: normalizedQuery,
          documents: rerankCandidates.map(chunk => chunk.content),
          topK: Math.min(RERANK_TOP_K, rerankCandidates.length),
          signal,
        });
        signal.throwIfAborted();
        // 重排返回的是这次输入数组的下标. 按返回顺序还原完整块, 再应用原文预算.
        const rankedChunks = ranked.results.map(item => rerankCandidates[item.index]!);
        return [timeline, {
          entities,
          relations,
          chunks: selectChunksWithinBudget(rankedChunks, characterLimit),
        }] as const;
      } catch (error) {
        throwIfCancelled(error, signal);
        return [timeline, timelineFailure(error)] as const;
      }
    }));
    return new Map<NarrativeTimelineId, NarrativeTimelineResult | NarrativeTimelineFailure>(entries);
  }
}
