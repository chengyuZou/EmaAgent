import { randomUUID } from 'node:crypto';
import { createEmbedCall, type CallEmbed, type EmbeddingResult } from '@ema-agent/embed';
import {
  createLLMCompletion,
  llmProviderErrorCode,
  type CompleteLLM,
  type LLMCompletion,
} from '@ema-agent/llm';
import { NarrativeSearch } from '@ema-agent/narrative';
import { ProviderError, type ModelBindings, type ProviderModels, type Providers } from '@ema-agent/providers';
import { createRerankCall, type CallRerank, type RerankResult } from '@ema-agent/rerank';
import type { SettingsStore } from '@ema-agent/settings';
import { NarrativeChunksRepo, NarrativeGraphRepo, type Database } from '@ema-agent/storage';
import type { ToolUseContext } from '@ema-agent/tools';
import type { UsageRecorder, UsageRecordStatus } from '@ema-agent/usage';
import { narrativeQueryModeSetting } from '../settings/narrativeSetting.js';

// 路由和关键词提取共用固定请求预算, 不把模型的最大输出容量当作本次预算.
const NARRATIVE_MAX_OUTPUT_TOKENS = 8_192;

export interface NarrativeComposition {
  /** 模型和算法在 Turn 准备时冻结; 用量归属该 Session 和 Turn. */
  resolveSearch(sessionId: string, turnId: string): ToolUseContext['narrativeSearch'];
}

export function openNarrative(
  db: Database,
  providers: Providers,
  providerModels: ProviderModels,
  modelBindings: ModelBindings,
  settings: SettingsStore,
  usageRecorder: UsageRecorder,
): NarrativeComposition {
  const search = new NarrativeSearch(
    new NarrativeChunksRepo(db.sqlite),
    new NarrativeGraphRepo(db.sqlite),
  );
  return {
    resolveSearch(sessionId, turnId) {
      const llm = modelBindings.get('narrative-llm');
      const embed = modelBindings.get('narrative-embed');
      const rerank = modelBindings.get('narrative-rerank');
      if (!llm || !embed || !rerank) {
        return undefined;
      }
      try {
        const model = providerModels.get(llm.providerId, 'llm', llm.modelId);
        const embedModel = providerModels.get(embed.providerId, 'embed', embed.modelId);
        const rerankModel = providerModels.get(rerank.providerId, 'rerank', rerank.modelId);
        if (model.capability !== 'llm' || !model.enabled || !embedModel.enabled || !rerankModel.enabled) {
          return undefined;
        }
        const completeLLM = createLLMCompletion(providers.resolveConnection(llm.providerId, 'llm'), llm.modelId);
        const callEmbed = createEmbedCall(providers.resolveConnection(embed.providerId, 'embed'), embed.modelId);
        const callRerank = createRerankCall(providers.resolveConnection(rerank.providerId, 'rerank'), rerank.modelId);
        const queryMode = settings.get(narrativeQueryModeSetting);

        const complete: CompleteLLM = async (request) => {
          request.signal?.throwIfAborted();
          const callId = randomUUID();
          const startedAt = Date.now();
          let completion: LLMCompletion | undefined;
          let status: UsageRecordStatus = 'completed';
          let errorCode: string | null = null;
          try {
            completion = await completeLLM({
              ...request,
              maxOutputTokens: NARRATIVE_MAX_OUTPUT_TOKENS,
            });
            if (completion.stopReason === 'max_tokens') {
              throw new Error('Narrative 路由输出达到上限, 结果未完整返回');
            }
          } catch (error) {
            const cancelled = request.signal?.aborted === true
              || (error instanceof Error && error.name === 'AbortError');
            status = cancelled ? 'cancelled' : 'failed';
            errorCode = cancelled ? 'llm/aborted' : llmProviderErrorCode(error);
            throw error;
          } finally {
            // 只记完整 completion 的最终用量. 中途抛错时没有 completion, Token 字段保持 null.
            usageRecorder.record({
              id: callId,
              sessionId,
              turnId,
              providerId: llm.providerId,
              modelId: llm.modelId,
              capability: 'llm',
              status,
              inputTokens: completion?.usage.inputTokens ?? null,
              outputTokens: completion?.usage.outputTokens ?? null,
              cacheReadInputTokens: completion?.usage.cacheReadInputTokens ?? null,
              cacheWriteInputTokens: completion?.usage.cacheWriteInputTokens ?? null,
              quantity: null,
              unit: null,
              durationMs: Date.now() - startedAt,
              errorCode,
              createdAt: startedAt,
            });
          }
          return completion;
        };

        const completeEmbed: CallEmbed = async request => {
          request.signal?.throwIfAborted();
          const callId = randomUUID();
          const startedAt = Date.now();
          let result: EmbeddingResult | undefined;
          let status: UsageRecordStatus = 'completed';
          let errorCode: string | null = null;
          try {
            result = await callEmbed(request);
            return result;
          } catch (error) {
            const cancelled = request.signal?.aborted === true
              || (error instanceof Error && error.name === 'AbortError');
            status = cancelled ? 'cancelled' : 'failed';
            errorCode = cancelled ? 'embed/aborted' : 'embed/failed';
            if (!cancelled && error instanceof Error && 'code' in error && typeof error.code === 'string') {
              errorCode = error.code;
            }
            throw error;
          } finally {
            usageRecorder.record({
              id: callId,
              sessionId,
              turnId,
              providerId: embed.providerId,
              modelId: embed.modelId,
              capability: 'embed',
              status,
              inputTokens: result?.usage?.inputTokens ?? null,
              outputTokens: null,
              cacheReadInputTokens: null,
              cacheWriteInputTokens: null,
              quantity: null,
              unit: null,
              durationMs: Date.now() - startedAt,
              errorCode,
              createdAt: startedAt,
            });
          }
        };

        const completeRerank: CallRerank = async request => {
          request.signal?.throwIfAborted();
          const callId = randomUUID();
          const startedAt = Date.now();
          let result: RerankResult | undefined;
          let status: UsageRecordStatus = 'completed';
          let errorCode: string | null = null;
          try {
            result = await callRerank(request);
            return result;
          } catch (error) {
            const cancelled = request.signal?.aborted === true
              || (error instanceof Error && error.name === 'AbortError');
            status = cancelled ? 'cancelled' : 'failed';
            errorCode = cancelled ? 'rerank/aborted' : 'rerank/failed';
            if (!cancelled && error instanceof Error && 'code' in error && typeof error.code === 'string') {
              errorCode = error.code;
            }
            throw error;
          } finally {
            usageRecorder.record({
              id: callId,
              sessionId,
              turnId,
              providerId: rerank.providerId,
              modelId: rerank.modelId,
              capability: 'rerank',
              status,
              inputTokens: result?.usage?.inputTokens ?? null,
              outputTokens: result?.usage?.outputTokens ?? null,
              cacheReadInputTokens: null,
              cacheWriteInputTokens: null,
              quantity: null,
              unit: null,
              durationMs: Date.now() - startedAt,
              errorCode,
              createdAt: startedAt,
            });
          }
        };

        return (query, mode, signal) => search.search(
          query,
          queryMode === 'auto' ? mode ?? 'hybrid' : queryMode,
          complete,
          completeEmbed,
          completeRerank,
          signal,
        );
      } catch (error) {
        if (error instanceof ProviderError) {
          return undefined;
        }
        throw error;
      }
    },
  };
}
