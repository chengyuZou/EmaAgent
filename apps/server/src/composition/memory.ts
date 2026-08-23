// 记忆一族：JobAdmin、提取/整合/维护三类执行器的装配与驱动、路由查询面。
// Turn completed 的提取入队与 Turn 终态同一事务（turn 包经闭包回调，不 import memory）；
// 驱动全部 fire-and-forget + 单飞，进程关闭经 shutdown 统一中止，终态遗留由启动恢复收口。
import { randomUUID } from 'node:crypto';
import { createLlmCall, createLlmCompletion, type Message } from '@ema-agent/llm';
import {
  createExtractTurn,
  createRelationshipConsolidate,
  createWorkConsolidate,
  JobAdmin,
  listRelationshipTargetPaths,
  listWorkTargetPaths,
  measureMemoryStorageBytes,
  memoryRootDir,
  readMemoryJobsSettings,
  readMemoryStorageLimit,
  relationshipMemoryDir,
  runConsolidationJobs,
  runExtractionJobs,
  runMaintenanceJobs,
  workMemoryDir,
  cleanupMemoryStorage,
  type ConsolidationKind,
  type MaintenanceKind,
  type MemoryEvent,
} from '@ema-agent/memory';
import { readMemoryLifecycleSettings } from '@ema-agent/memory';
import type { ModelBindings, Providers } from '@ema-agent/providers';
import type { SessionStore } from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import { MemoryJobsRepo, type Database } from '@ema-agent/storage';
import type { TurnStore } from '@ema-agent/turn';
import { createUsageRecord, reportUsage, type UsageRecorder } from '@ema-agent/usage';
import type { MemoryTurnMessage } from '@ema-agent/memory';

export interface MemoryComposition {
  readonly admin: JobAdmin;
  readonly jobs: MemoryJobsRepo;
  readonly memoryRoot: string;
  /** Turn 终态事务内调用：只入队两行提取 Job，并安排事务提交后的 drain。 */
  readonly enqueueTurnExtraction: (turnId: string) => void;
  /** 手动触发一次整合（整合冷却由执行器判定）。 */
  readonly startConsolidation: (kind: ConsolidationKind) => void;
  /** 手动触发维护 Job（clear_memory / storage_cleanup）。 */
  readonly startMaintenance: (kind: MaintenanceKind) => void;
  /** 进程关闭序列调用：中止在途 Job，不写终态（由下次启动恢复收口）。 */
  readonly shutdown: () => void;
}

export function openMemory(deps: {
  readonly dataDb: Database;
  readonly settings: SettingsStore;
  readonly providers: Providers;
  readonly modelBindings: ModelBindings;
  readonly session: SessionStore;
  readonly turns: TurnStore;
  readonly usageRecorder: UsageRecorder;
  readonly emitApp: (event: MemoryEvent) => void;
}): MemoryComposition {
  const jobs = new MemoryJobsRepo(deps.dataDb.sqlite);
  const admin = new JobAdmin(jobs, deps.emitApp);
  const memoryRoot = memoryRootDir();
  const shutdownController = new AbortController();

  // memory-llm 绑定缺失即提取链不可用：Job 会在执行时失败并留 error，不拦入队。
  const complete = async (messages: readonly Message[], signal?: AbortSignal): Promise<string> => {
    const binding = deps.modelBindings.get('memory-llm');
    if (!binding) throw new Error('未配置 memory-llm 模型绑定');
    const callLlm = createLlmCall(
      deps.providers.resolveConnection(binding.providerId, 'llm'),
      binding.modelId,
    );
    const startedAt = Date.now();
    const completion = await createLlmCompletion(callLlm({ messages, ...(signal ? { signal } : {}) }));
    reportUsage(deps.usageRecorder, createUsageRecord({
      capability: 'llm',
      providerId: binding.providerId,
      modelId: binding.modelId,
      status: 'completed',
      startedAt,
      durationMs: Date.now() - startedAt,
      ...(completion.usage ? {
        inputTokens: completion.usage.inputTokens,
        outputTokens: completion.usage.outputTokens,
        cacheReadInputTokens: completion.usage.cacheReadInputTokens ?? null,
        cacheWriteInputTokens: completion.usage.cacheWriteInputTokens ?? null,
      } : {}),
    }), error => console.warn('[usage] Memory LLM 记账失败:', error));
    return completion.blocks
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
  };

  const extractTurn = createExtractTurn({
    loadCompletedTurn: async turnId => {
      const turn = deps.turns.getTurn(turnId);
      // 提取输入要求 Turn 已落终态；查不到即 Job 失败留 error，不拦入队。
      if (!turn) throw new Error(`Turn 不存在: ${turnId}`);
      const session = deps.session.getSession(turn.sessionId);
      return {
        messages: projectMemoryTurnMessages(deps.session.loadMessagesForTurn(turnId)),
        ...(session.workspaceRoot ? { workspaceRoot: session.workspaceRoot } : {}),
        ...(turn.characterDirectoryName
          ? { characterDirectoryName: turn.characterDirectoryName }
          : {}),
      };
    },
    complete,
  });

  // ── 提取驱动：单飞 drain；一次 drain 有产出即按轨补一次整合认领。 ──────────────
  let extractionDrain: Promise<unknown> | null = null;
  const kickExtraction = (): void => {
    if (extractionDrain) return;
    const concurrency = readMemoryJobsSettings(deps.settings).extractionConcurrency;
    extractionDrain = runExtractionJobs({
      jobs,
      admin,
      extractTurn,
      concurrency,
      signal: shutdownController.signal,
    })
      .then(stats => {
        if (stats.succeededWithOutput > 0) {
          composition.startConsolidation('work_consolidation');
          composition.startConsolidation('relationship_consolidation');
        }
      })
      .catch(error => console.warn('[memory] 提取队列执行失败:', error))
      .finally(() => { extractionDrain = null; });
  };

  const consolidationRunning = new Set<ConsolidationKind>();
  const launchConsolidation = (kind: ConsolidationKind): void => {
    if (shutdownController.signal.aborted || consolidationRunning.has(kind)) return;
    consolidationRunning.add(kind);
    const isWork = kind === 'work_consolidation';
    const settings = readMemoryJobsSettings(deps.settings);
    void runConsolidationJobs({
      jobs,
      admin,
      memoryDirectoryFor: track => (track === 'work_consolidation' ? workMemoryDir() : relationshipMemoryDir()),
      listTargetPaths: isWork ? listWorkTargetPaths : listRelationshipTargetPaths,
      consolidate: isWork
        ? createWorkConsolidate({ complete })
        : createRelationshipConsolidate({ complete }),
      cooldownHours: settings.consolidationCooldownHours,
      heartbeatSeconds: settings.heartbeatSeconds,
      signal: shutdownController.signal,
    }, kind)
      .catch(error => console.warn(`[memory] 整合执行失败(${kind}):`, error))
      .finally(() => consolidationRunning.delete(kind));
  };

  const maintenanceRunning = new Set<MaintenanceKind>();
  const launchMaintenance = (kind: MaintenanceKind): void => {
    if (shutdownController.signal.aborted || maintenanceRunning.has(kind)) return;
    maintenanceRunning.add(kind);
    void runMaintenanceJobs({
      jobs,
      admin,
      memoryRoot,
      cleanup: (signal, lockFiles) => cleanupMemoryStorage(
        memoryRoot,
        readMemoryStorageLimit(deps.settings),
        readMemoryLifecycleSettings(deps.settings),
        signal,
        lockFiles,
      ),
      heartbeatSeconds: readMemoryJobsSettings(deps.settings).heartbeatSeconds,
      signal: shutdownController.signal,
    }, kind)
      .catch(error => console.warn(`[memory] 维护执行失败(${kind}):`, error))
      .finally(() => maintenanceRunning.delete(kind));
  };

  const composition: MemoryComposition = {
    admin,
    jobs,
    memoryRoot,
    enqueueTurnExtraction: turnId => {
      admin.enqueueExtraction(turnId);
      // 此刻仍在 Turn 终态事务内（同步块）；drain 安排到事务提交后。
      queueMicrotask(kickExtraction);
    },
    startConsolidation: kind => {
      jobs.enqueue({ id: randomUUID(), kind, createdAt: Date.now() });
      launchConsolidation(kind);
    },
    startMaintenance: kind => {
      jobs.enqueue({ id: randomUUID(), kind, createdAt: Date.now() });
      launchMaintenance(kind);
    },
    shutdown: () => {
      shutdownController.abort();
      admin.abortAll();
    },
  };

  return composition;
}

/** 持久消息 → Memory 提取输入投影；reminder/summary 不进（它们是背景与压缩产物）。 */
function projectMemoryTurnMessages(
  messages: readonly ReturnType<SessionStore['loadMessagesForTurn']>[number][],
): MemoryTurnMessage[] {
  const out: MemoryTurnMessage[] = [];
  for (const message of messages) {
    if (message.kind === 'reminder' || message.kind === 'summary') continue;
    const blocks = message.blocks;
    if (typeof blocks === 'string') {
      if (message.role === 'user' && blocks.trim()) {
        out.push({ kind: 'user_message', text: blocks });
      }
      continue;
    }
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const candidate = block as Record<string, unknown>;
      if (candidate.type === 'text' && typeof candidate.text === 'string' && candidate.text.trim()) {
        out.push(message.role === 'assistant'
          ? { kind: 'assistant_message', text: candidate.text }
          : { kind: 'user_message', text: candidate.text });
        continue;
      }
      if (message.role === 'assistant' && candidate.type === 'tool_use') {
        out.push({
          kind: 'tool_call',
          toolCallId: String(candidate.id ?? ''),
          toolName: String(candidate.name ?? ''),
          input: typeof candidate.args === 'string' ? candidate.args : JSON.stringify(candidate.args ?? null),
        });
        continue;
      }
      if (message.role === 'user' && candidate.type === 'tool_result') {
        out.push({
          kind: 'tool_result',
          toolCallId: String(candidate.toolCallId ?? ''),
          content: typeof candidate.content === 'string' ? candidate.content : JSON.stringify(candidate.content ?? ''),
          isError: candidate.isError === true,
        });
      }
    }
  }
  return out;
}
