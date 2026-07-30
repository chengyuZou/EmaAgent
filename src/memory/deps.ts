import type {
  MemoryNodesRepo,
  MemoryEdgesRepo,
  MemoryLazyUpdatesRepo,
  MemoryItemsRepo,
  MemoryNodeSourcesRepo,
  SessionNotesRepo,
  MemoryTasksRepo,
  MemorySessionStateRepo,
  PendingFragmentsRepo,
  ModelBindingsRepo,
  MemoryExtractionRunsRepo,
  MemoryStorageRepo,
} from '@ema-agent/storage';
import type { SessionStore } from '@ema-agent/session';
import type { LanguageModel } from '@ema-agent/llm';
import type { EmbedRuntime } from '@ema-agent/embed';
import type { RerankRuntime } from '@ema-agent/rerank';
import type { MemoryBackgroundEvent } from './events.js';

/** MemoryPlanner 的仓库和模型能力全部由应用装配层一次性注入。 */
export interface MemoryDeps {
  session:        SessionStore;
  llm:            LanguageModel;
  embedRuntime:   EmbedRuntime;
  rerankRuntime:  RerankRuntime;
  modelBindings:  ModelBindingsRepo;

  // Memory 拥有的持久化入口。
  nodes:          MemoryNodesRepo;
  edges:          MemoryEdgesRepo;
  lazyUpdates:    MemoryLazyUpdatesRepo;
  nodeSources:    MemoryNodeSourcesRepo;
  items:          MemoryItemsRepo;
  sessionNotes:      SessionNotesRepo;
  memoryTasks:   MemoryTasksRepo;
  memorySessionState: MemorySessionStateRepo;
  pendingFragments:  PendingFragmentsRepo;
  extractionRuns:    MemoryExtractionRunsRepo;
  storage:           MemoryStorageRepo;

  /** profile.db 内的同步短事务；回调不得执行网络或其他异步 I/O。 */
  runProfileTransaction: <T>(work: () => T) => T;
  /** data.db 内的同步短事务；用于原子提交 session note 与 pending 清理。 */
  runDataTransaction:    <T>(work: () => T) => T;

  /** 按 Provider 配置实例和模型精确查询向量维度，禁止按裸模型名猜测。 */
  getEmbedDim:    (providerId: string, model: string) => number;

  /** 后台生命周期事件由应用装配层接入全局事件通道；测试可以省略。 */
  emit?:          (ev: MemoryBackgroundEvent) => void;
}
