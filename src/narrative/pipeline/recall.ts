import { setImmediate } from 'node:timers/promises';
import type { CallEmbed } from '@ema-agent/embed';
import type { CallLlm } from '@ema-agent/llm';
import type {
  NarrativeChunksRepo,
  NarrativeGraphRepo,
  NarrativeKeywordCacheRepo,
  NarrativeKeywords,
  NarrativeTimelineId,
} from '@ema-agent/storage';
import { throwIfCancelled } from '../errors.js';
import type {
  NarrativeQueryMode,
  NarrativeRecallResult,
  NarrativeTimelineFailure,
  NarrativeTimelineResult,
} from '../types.js';
import { EMBEDDING_DIM } from './constants.js';
import { extractKeywords } from './keywords.js';
import { embeddingTexts, queryTimeline } from './query.js';
import { routeTimelines } from './router.js';

function timelineFailure(error: unknown): NarrativeTimelineFailure {
  return {
    code: 'timeline_query_failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

export class NarrativeSearch {
  // 只持有数据库访问入口. 资产向量、查询向量和中间结果都属于一次 search, 不随实例缓存.
  constructor(
    private readonly chunks: NarrativeChunksRepo,
    private readonly graph: NarrativeGraphRepo,
    private readonly keywordCache: NarrativeKeywordCacheRepo,
  ) {}

  /**
   * query 是用户问题, mode 只选择召回算法, 不改变周目路由. 返回背景文本, 不生成最终回答.
   * callLlm 负责路由/提词; 协议必填参数和重试由宿主配置. callEmbed 必须使用资产的 Pro/bge-m3.
   * 同为 1024 维的其他模型也不能与这些资产比较. signal 贯穿模型调用和计算, 取消向调用方抛出.
   */
  async search(
    query: string,
    mode: NarrativeQueryMode,
    callLlm: CallLlm,
    callEmbed: CallEmbed,
    signal: AbortSignal,
  ): Promise<NarrativeRecallResult> {
    // 同一人物在不同周目的事件不同, 先路由并拆出子问题; 路由失败无法确定搜索范围, 整次查询抛错.
    const routes = await routeTimelines(query, callLlm, signal);
    const queries = [...new Set(routes.values())];

    // 相同子问题可能分到多个周目, 只提词一次. Promise.all 等待可重叠的模型请求, 返回顺序不变.
    const prepared = await Promise.all(queries.map(async subquery => {
      try {
        let keywords: NarrativeKeywords = { highLevelKeywords: [], lowLevelKeywords: [] };
        if (mode !== 'naive') {
          // naive 直接用子问题搜索文本块, 不消费图关键词, 因此不调用提词模型.
          keywords = await extractKeywords(subquery, mode, this.keywordCache, callLlm, signal);
        }
        return { keywords };
      } catch (error) {
        throwIfCancelled(error, signal);
        return timelineFailure(error);
      }
    }));
    const byQuery = new Map(queries.map((subquery, index) => [subquery, prepared[index]!]));
    const texts = new Set<string>();
    for (const [subquery, item] of byQuery) {
      if ('keywords' in item) {
        for (const text of embeddingTexts(subquery, mode, item.keywords)) {
          texts.add(text);
        }
      }
    }
    const embeddings = new Map<string, Float32Array>();
    let embeddingFailure: NarrativeTimelineFailure | undefined;
    if (texts.size > 0) {
      try {
        signal.throwIfAborted();
        const inputs = [...texts];
        // 所有周目的子问题和关键词合成一次批量编码; 返回数组按输入顺序与文本配对.
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
    // 各周目独立调度, 单周目失败不拒绝其他任务. Promise.all 保留路由顺序, 不按完成顺序组装 Map.
    const entries = await Promise.all([...routes].map(async ([timeline, subquery]) => {
      signal.throwIfAborted();
      const item = byQuery.get(subquery)!;
      if ('code' in item) {
        return [timeline, item] as const;
      }
      if (embeddingFailure && embeddingTexts(subquery, mode, item.keywords).length > 0) {
        // 一次批量编码失败会影响所有需要它的周目; 没有关键词且不需要编码的周目仍返回空背景.
        return [timeline, embeddingFailure] as const;
      }
      try {
        // 等待事件循环调度, 让等待中的任务能响应取消. SQL 和向量计算仍在同一线程轮流执行,
        // 不会多核并行, 也不能在一次同步 queryTimeline 的中途处理新的取消事件.
        await setImmediate(undefined, { signal });
        const text = queryTimeline(
          timeline, subquery, mode, item.keywords, embeddings,
          this.chunks, this.graph, signal,
        );
        return [timeline, { text }] as const;
      } catch (error) {
        throwIfCancelled(error, signal);
        return [timeline, timelineFailure(error)] as const;
      }
    }));
    return new Map<NarrativeTimelineId, NarrativeTimelineResult>(entries);
  }
}
