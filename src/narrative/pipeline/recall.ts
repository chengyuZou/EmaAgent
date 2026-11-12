import { setImmediate } from 'node:timers/promises';
import type { CallEmbed } from '@ema-agent/embed';
import type { CompleteLLM } from '@ema-agent/llm';
import type { CallRerank } from '@ema-agent/rerank';
import type {
  NarrativeChunkRow,
  NarrativeChunksRepo,
  NarrativeChunkVectorRow,
  NarrativeGraphRepo,
  NarrativeTimelineId,
} from '@ema-agent/storage';
import { throwIfCancelled } from '../errors.js';
import type {
  NarrativeQueryMode,
  NarrativeRecallResult,
  NarrativeTimelineFailure,
} from '../types.js';
import { selectChunksWithinBudget } from './chunkBudget.js';
import {
  EMBEDDING_DIM,
  MAX_CHUNK_CHARACTERS,
  RERANK_CANDIDATE_LIMIT,
  RERANK_TOP_K,
  TIMELINES,
} from './constants.js';
import { collectEmbeddingTexts, queryGraphCandidates } from './query.js';
import { retrieveNaive } from './retrieval/naive.js';
import { extractKeywords, routeTimelines } from './router.js';

function timelineFailure(error: unknown): NarrativeTimelineFailure {
  return {
    message: error instanceof Error ? error.message : String(error),
  };
}

async function embedTexts(
  texts: readonly string[],
  callEmbed: CallEmbed,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, Float32Array>> {
  signal.throwIfAborted();
  const inputs = [...new Set(texts)];
  const embedded = await callEmbed({ texts: inputs, signal });
  signal.throwIfAborted();
  if (embedded.dim !== EMBEDDING_DIM) {
    throw new RangeError(`Narrative 需要 ${EMBEDDING_DIM} 维向量, 当前返回 ${embedded.dim} 维`);
  }
  const embeddings = new Map<string, Float32Array>();
  for (let index = 0; index < inputs.length; index++) {
    embeddings.set(inputs[index]!, Float32Array.from(embedded.embeddings[index]!));
  }
  return embeddings;
}

export class NarrativeSearch {
  // 向量及中间结果只属于一次 search, 不随实例缓存.
  constructor(
    private readonly chunks: NarrativeChunksRepo,
    private readonly graph: NarrativeGraphRepo,
  ) {}

  /**
   * naive 需要周目判断, 其余模式需要提词. callEmbed 必须使用资产原有的向量空间.
   * 重排比较完整 query 和原文块, 各周目独立发送重排请求.
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

    if (mode === 'naive') {
      // 编码只需要原 Query, 可以和周目判断同时发出. 读库前需要两个结果都成功.
      const [routedTimelines, embeddings] = await Promise.all([
        routeTimelines(normalizedQuery, completeLLM, signal),
        embedTexts([normalizedQuery], callEmbed, signal),
      ]);
      const queryEmbedding = embeddings.get(normalizedQuery)!;

      // 同步读取 SQLite 前让出一次事件循环, 接收已排队的取消事件.
      await setImmediate();
      signal.throwIfAborted();

      const vectorsByTimeline = new Map<NarrativeTimelineId, NarrativeChunkVectorRow[]>(
        routedTimelines.map(timelineId => [timelineId, []]),
      );
      for (const row of this.chunks.listVectors(routedTimelines)) {
        vectorsByTimeline.get(row.timeline_id)!.push(row);
      }

      const idsByTimeline = new Map<NarrativeTimelineId, string[] | NarrativeTimelineFailure>();
      for (const [timelineId, vectorRows] of vectorsByTimeline) {
        try {
          const ids = retrieveNaive(queryEmbedding, vectorRows, signal);
          if (ids.length > 0) {
            idsByTimeline.set(timelineId, ids.slice(0, RERANK_CANDIDATE_LIMIT));
          }
        } catch (error) {
          throwIfCancelled(error, signal);
          idsByTimeline.set(timelineId, timelineFailure(error));
        }
      }
      const chunksByTimeline = await this.readAndRerankChunks(
        normalizedQuery, idsByTimeline, routedTimelines.length, callRerank, signal,
      );
      return { entities: [], relations: [], chunksByTimeline };
    }

    const keywords = await extractKeywords(normalizedQuery, completeLLM, signal);
    const texts = collectEmbeddingTexts(normalizedQuery, mode, keywords);
    if (texts.length === 0) {
      return { entities: [], relations: [], chunksByTimeline: new Map() };
    }

    const embeddings = await embedTexts(texts, callEmbed, signal);
    await setImmediate();
    signal.throwIfAborted();
    const { entities, relations, chunkIdsByTimeline } = queryGraphCandidates(
      normalizedQuery,
      mode,
      keywords,
      embeddings,
      this.chunks,
      this.graph,
      signal,
    );
    const chunksByTimeline = await this.readAndRerankChunks(
      normalizedQuery, chunkIdsByTimeline, TIMELINES.length, callRerank, signal,
    );
    return { entities, relations, chunksByTimeline };
  }

  private async readAndRerankChunks(
    query: string,
    candidateChunkIdsByTimeline: ReadonlyMap<
      NarrativeTimelineId,
      readonly string[] | NarrativeTimelineFailure
    >,
    timelineCount: number,
    callRerank: CallRerank,
    signal: AbortSignal,
  ): Promise<NarrativeRecallResult['chunksByTimeline']> {
    // 所有周目共用一次正文读取. Repo 返回 ID 到正文的 Map, 保留到这次重排结束.
    const chunkIds = [...candidateChunkIdsByTimeline.values()].flatMap(ids =>
      'message' in ids ? [] : ids,
    );
    const chunksById = this.chunks.findChunksByIds(chunkIds);
    signal.throwIfAborted();

    // naive 按路由范围均分预算. 图模式的查询范围是全库.
    const characterLimit = Math.floor(MAX_CHUNK_CHARACTERS / timelineCount);
    const entries = await Promise.all(
      [...candidateChunkIdsByTimeline].map(async ([timelineId, ids]) => {
        if ('message' in ids) {
          return [timelineId, ids] as const;
        }
        // SQL 返回顺序不影响重排输入. 每个周目按它的候选 ID 顺序取正文.
        const rerankCandidates = ids.flatMap(chunkId => {
          const chunk = chunksById.get(chunkId);
          return chunk === undefined ? [] : [chunk];
        });
        if (rerankCandidates.length === 0) {
          return [timelineId, []] as const;
        }

        try {
          signal.throwIfAborted();
          const ranked = await callRerank({
            query,
            documents: rerankCandidates.map(chunk => chunk.content),
            topK: Math.min(RERANK_TOP_K, rerankCandidates.length),
            signal,
          });
          signal.throwIfAborted();
          const rankedChunks = ranked.results.map(item => rerankCandidates[item.index]!);
          return [timelineId, selectChunksWithinBudget(rankedChunks, characterLimit)] as const;
        } catch (error) {
          throwIfCancelled(error, signal);
          return [timelineId, timelineFailure(error)] as const;
        }
      }),
    );
    signal.throwIfAborted();
    return new Map<NarrativeTimelineId, readonly NarrativeChunkRow[] | NarrativeTimelineFailure>(
      entries.filter(([, result]) => 'message' in result || result.length > 0),
    );
  }
}
