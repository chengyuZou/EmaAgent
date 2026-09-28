// 知识库一族：KbManager（注册表/激活/摄入/检索）与其库级模型调用的惰性解析。
// Embed/Rerank 模型是各库注册行上的属性;resolveEmbedFor/RerankFor 按引用解析,
// 未配置或能力被禁用即 undefined（该库检索降级，不阻塞主链路）。
// 模型身份在闭包创建时冻结；usage 在闭包内"调接口得结果 → 从结果记录"，
// knowledge 业务包不感知 providerId/modelId，也不感知用量。
import { randomUUID } from 'node:crypto';
import { createEmbedCall, createEmbeddingSpace, EmbeddingError } from '@ema-agent/embed';
import {
  KbManager,
  readKnowledgeRetrievalSettings,
  type CallEmbed,
  type KnowledgeSearch,
} from '@ema-agent/knowledge';
import {
  ProviderError,
  type ModelBindings,
  type ProviderModels,
  type Providers,
} from '@ema-agent/providers';
import { createRerankCall, RerankError, type CallRerank } from '@ema-agent/rerank';
import type { SettingsStore } from '@ema-agent/settings';
import { KbRegistryRepo, type Database, type KbModelRef } from '@ema-agent/storage';
import type { UsageRecorder } from '@ema-agent/usage';
import { createVisionCall, VisionError, type CallVision } from '@ema-agent/vision';

export interface KnowledgeComposition {
  readonly kb: KbManager;
  /** 模型工具路径的检索入口（KnowledgeSearch）；HTTP 面板直接用 KbManager。 */
  readonly knowledgeSearch: KnowledgeSearch;
}

export function openKnowledge(
  profileDb: Database,
  providers: Providers,
  providerModels: ProviderModels,
  modelBindings: ModelBindings,
  settings: SettingsStore,
  usageRecorder: UsageRecorder,
): KnowledgeComposition {
  const registry = new KbRegistryRepo(profileDb.sqlite);

  const resolveEmbedFor = (ref: KbModelRef): CallEmbed | undefined => {
    try {
      const callEmbed = createEmbedCall(providers.resolveConnection(ref.providerId, 'embed'), ref.modelId);
      return async (request) => {
        const startedAt = Date.now();
        const callId = randomUUID();
        const result = await callEmbed(request).catch(error => {
          const cancelled = request.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
          let errorCode = 'embed/call_failed';
          if (cancelled) errorCode = 'embed/aborted';
          else if (error instanceof EmbeddingError) errorCode = error.code;
          recordModelUsage(usageRecorder, 'embed', ref, callId, startedAt,
            cancelled ? 'cancelled' : 'failed', null, errorCode);
          throw error;
        });
        recordModelUsage(usageRecorder, 'embed', ref, callId, startedAt, 'completed', {
          inputTokens: result.usage?.inputTokens ?? null,
        }, null);
        return {
          ...result,
          space: createEmbeddingSpace({
            providerId: ref.providerId,
            model: ref.modelId,
            dim: result.dim,
          }),
        };
      };
    } catch (err) {
      if (err instanceof ProviderError) return undefined;
      throw err;
    }
  };
  const resolveRerankFor = (ref: KbModelRef): CallRerank | undefined => {
    try {
      const callRerank = createRerankCall(providers.resolveConnection(ref.providerId, 'rerank'), ref.modelId);
      return async (request) => {
        const startedAt = Date.now();
        const callId = randomUUID();
        const result = await callRerank(request).catch(error => {
          const cancelled = request.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
          let errorCode = 'rerank/call_failed';
          if (cancelled) errorCode = 'rerank/aborted';
          else if (error instanceof RerankError) errorCode = error.code;
          recordModelUsage(usageRecorder, 'rerank', ref, callId, startedAt,
            cancelled ? 'cancelled' : 'failed', null, errorCode);
          throw error;
        });
        recordModelUsage(usageRecorder, 'rerank', ref, callId, startedAt, 'completed', {
          inputTokens: result.usage?.totalTokens ?? null,
        }, null);
        return result;
      };
    } catch (err) {
      if (err instanceof ProviderError) return undefined;
      throw err;
    }
  };
  const resolveVision = (): CallVision | undefined => {
    const binding = modelBindings.get('vision');
    if (!binding) return undefined;
    try {
      const vision = createVisionCall(providers.resolveConnection(binding.providerId, 'vision'), binding.modelId);
      return async (request) => {
        const startedAt = Date.now();
        const callId = randomUUID();
        const result = await vision(request).catch(error => {
          const cancelled = request.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
          let errorCode = 'vision/call_failed';
          if (cancelled) errorCode = 'vision/aborted';
          else if (error instanceof VisionError) errorCode = error.code;
          recordModelUsage(usageRecorder, 'vision', binding, callId, startedAt,
            cancelled ? 'cancelled' : 'failed', null, errorCode);
          throw error;
        });
        recordModelUsage(usageRecorder, 'vision', binding, callId, startedAt, 'completed', {
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
          cacheReadInputTokens: result.usage?.cacheReadInputTokens ?? null,
          cacheWriteInputTokens: result.usage?.cacheWriteInputTokens ?? null,
        }, null);
        return result;
      };
    } catch (err) {
      if (err instanceof ProviderError) return undefined;
      throw err;
    }
  };

  const kb = new KbManager({
    registry,
    resolveEmbedFor,
    resolveRerankFor,
    resolveVision,
    // 库级 stale 探空:用模型行上的 dim 算空间 id,不发网络请求;行缺失时由 PATCH 校验拦下,这里兜底跳过。
    resolveEmbeddingSpaceId: (ref) => {
      const model = providerModels.get(ref.providerId, 'embed', ref.modelId);
      if (!model || model.capability !== 'embed') return undefined;
      return createEmbeddingSpace({ providerId: ref.providerId, model: ref.modelId, dim: model.dim }).id;
    },
    // 用户设置只在一次真实检索开始时读取；排队或执行中的操作继续使用已取得的值。
    resolveRetrievalSettings: () => readKnowledgeRetrievalSettings(settings),
  });

  return {
    kb,
    knowledgeSearch: request => kb.searchActive(request),
  };
}

/** Record one physical model call after its provider returns or throws. */
function recordModelUsage(
  recorder: UsageRecorder,
  capability: 'embed' | 'rerank' | 'vision',
  ref: KbModelRef,
  callId: string,
  startedAt: number,
  status: 'completed' | 'failed' | 'cancelled',
  tokens: {
    inputTokens: number | null;
    outputTokens?: number | null;
    cacheReadInputTokens?: number | null;
    cacheWriteInputTokens?: number | null;
  } | null,
  errorCode: string | null,
): void {
  recorder.record({
    id: callId,
    sessionId: null,
    turnId: null,
    capability,
    providerId: ref.providerId,
    modelId: ref.modelId,
    status,
    durationMs: Date.now() - startedAt,
    inputTokens: tokens?.inputTokens ?? null,
    outputTokens: tokens?.outputTokens ?? null,
    cacheReadInputTokens: tokens?.cacheReadInputTokens ?? null,
    cacheWriteInputTokens: tokens?.cacheWriteInputTokens ?? null,
    quantity: null,
    unit: null,
    errorCode,
    createdAt: startedAt,
  });
}
