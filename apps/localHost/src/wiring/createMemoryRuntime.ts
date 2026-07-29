// 装配 Memory Planner 及其 Profile/Data DB 仓库，不启动后台索引或 Worker。

import type { EmbedRuntime } from '@ema-agent/embed';
import type { LanguageModelRuntime } from '@ema-agent/llm';
import { MemoryPlanner, type MemoryBackgroundEvent } from '@ema-agent/memory';
import type { RerankRuntime } from '@ema-agent/rerank';
import type { SessionStore } from '@ema-agent/session';
import {
  MemoryEdgesRepo,
  MemoryExtractionRunsRepo,
  MemoryItemsRepo,
  MemoryLazyUpdatesRepo,
  MemoryNodesRepo,
  MemorySessionStateRepo,
  MemoryTasksRepo,
  PendingFragmentsRepo,
  type Database,
  type ModelBindingsRepo,
  type ProviderEmbedModelsRepo,
  type SessionNotesRepo,
} from '@ema-agent/storage';

export function createMemoryRuntime(
  profileDb: Database,
  dataDb: Database,
  session: SessionStore,
  sessionNotes: SessionNotesRepo,
  llm: LanguageModelRuntime,
  embed: EmbedRuntime,
  rerank: RerankRuntime,
  modelBindings: ModelBindingsRepo,
  providerEmbedModels: ProviderEmbedModelsRepo,
  emit: (event: MemoryBackgroundEvent) => void,
): MemoryPlanner {
  return new MemoryPlanner({
    session,
    llm,
    embedRuntime: embed,
    rerankRuntime: rerank,
    modelBindings,
    nodes: new MemoryNodesRepo(profileDb.sqlite),
    edges: new MemoryEdgesRepo(profileDb.sqlite),
    lazyUpdates: new MemoryLazyUpdatesRepo(profileDb.sqlite),
    items: new MemoryItemsRepo(profileDb.sqlite),
    sessionNotes,
    memoryTasks: new MemoryTasksRepo(dataDb.sqlite),
    pendingFragments: new PendingFragmentsRepo(dataDb.sqlite),
    memorySessionState: new MemorySessionStateRepo(dataDb.sqlite),
    extractionRuns: new MemoryExtractionRunsRepo(profileDb.sqlite),
    runProfileTransaction: <T>(work: () => T): T =>
      profileDb.sqlite.transaction(work)(),
    runDataTransaction: <T>(work: () => T): T =>
      dataDb.sqlite.transaction(work)(),
    // 向量空间身份必须按 Provider 实例和模型精确匹配，不能跨供应商猜维度。
    getEmbedDim: (providerId, model) =>
      providerEmbedModels.dimFor(providerId, model) ?? 0,
    emit,
  });
}
