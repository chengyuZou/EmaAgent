import { randomUUID } from 'node:crypto';
import {
  createLlmCall,
  createLlmCompletion,
  type Message,
} from '@ema-agent/llm';
import {
  createExtractTurn,
  createRelationshipConsolidate,
  createWorkConsolidate,
  maintainRelationshipMemory,
  maintainWorkMemory,
  MEMORY_CONSOLIDATION_CHECK_INTERVAL_MS,
  MEMORY_CONSOLIDATION_MAX_WAIT_MS,
  MEMORY_CONSOLIDATION_MIN_RESULTS,
  MEMORY_MAINTENANCE_INTERVAL_MS,
  memoryRootDir,
  relationshipMemoryDir,
  runConsolidationJobs,
  runExtractionJobs,
  runMaintenanceJob,
  workMemoryDir,
  type ConsolidationKind,
} from '@ema-agent/memory';
import type { ModelBindings, Providers } from '@ema-agent/providers';
import type { SessionStore } from '@ema-agent/session';
import {
  MemoryRepo,
  type Database,
  type MemoryExtractionJobKind,
  type MemoryMaintenanceJobKind,
} from '@ema-agent/storage';
import type { TurnStore } from '@ema-agent/turn';
import { createUsageRecord, reportUsage, type UsageRecorder } from '@ema-agent/usage';

export interface MemoryComposition {
  readonly jobs: MemoryRepo;
  readonly memoryRoot: string;
  readonly enqueueTurnExtraction: (turnId: string) => void;
  /** HTTP ready 后启动恢复和定时器，避免 Memory IO 延长应用启动。 */
  readonly start: () => void;
  readonly shutdown: () => void;
}

export function openMemory(deps: {
  readonly dataDb: Database;
  readonly providers: Providers;
  readonly modelBindings: ModelBindings;
  readonly session: SessionStore;
  readonly turns: TurnStore;
  readonly usageRecorder: UsageRecorder;
}): MemoryComposition {
  const jobs = new MemoryRepo(deps.dataDb.sqlite);
  const memoryRoot = memoryRootDir();
  const shutdownController = new AbortController();
  let started = false;
  let consolidationTimer: NodeJS.Timeout | undefined;
  let maintenanceTimer: NodeJS.Timeout | undefined;

  const complete = async (messages: readonly Message[], signal?: AbortSignal): Promise<string> => {
    const binding = deps.modelBindings.get('memory-llm');
    if (!binding) throw new Error('未配置 memory-llm 模型绑定');
    const callLlm = createLlmCall(
      deps.providers.resolveConnection(binding.providerId, 'llm'),
      binding.modelId,
    );
    const startedAt = Date.now();
    const completion = await createLlmCompletion(callLlm({
      messages,
      ...(signal ? { signal } : {}),
    }));
    reportUsage(deps.usageRecorder, createUsageRecord({
      capability: 'llm',
      providerId: binding.providerId,
      modelId: binding.modelId,
      status: 'completed',
      startedAt,
      durationMs: Date.now() - startedAt,
      inputTokens: completion.usage?.inputTokens ?? null,
      outputTokens: completion.usage?.outputTokens ?? null,
      cacheReadInputTokens: completion.usage?.cacheReadInputTokens ?? null,
      cacheWriteInputTokens: completion.usage?.cacheWriteInputTokens ?? null,
    }), error => console.warn('[usage] Memory LLM 记账失败:', error));
    return completion.blocks
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
  };

  const extractTurn = createExtractTurn({
    loadCompletedTurn: async turnId => {
      const turn = deps.turns.getTurn(turnId);
      if (!turn) throw new Error(`Turn 不存在: ${turnId}`);
      return {
        sessionId: turn.sessionId,
        messages: buildMemoryMessages(deps.session.loadMessagesForTurn(turnId)),
        ...(turn.characterDirectoryName
          ? { characterName: turn.characterDirectoryName }
          : {}),
      };
    },
    complete,
  });

  const workConsolidate = createWorkConsolidate({ complete });
  const relationshipConsolidate = createRelationshipConsolidate({ complete });
  const extractionDrains = new Map<MemoryExtractionJobKind, Promise<void>>();
  const consolidationDrains = new Map<ConsolidationKind, Promise<void>>();
  const maintenanceDrains = new Map<MemoryMaintenanceJobKind, Promise<void>>();

  const consolidationReady = (kind: ConsolidationKind): boolean => {
    const readiness = kind === 'work_consolidation'
      ? jobs.workReadiness()
      : jobs.relationshipReadiness();
    return readiness.count >= MEMORY_CONSOLIDATION_MIN_RESULTS
      || (
        readiness.count > 0
        && readiness.oldestCreatedAt !== null
        && Date.now() - readiness.oldestCreatedAt >= MEMORY_CONSOLIDATION_MAX_WAIT_MS
      );
  };

  const kickConsolidation = (kind: ConsolidationKind): void => {
    if (shutdownController.signal.aborted || consolidationDrains.has(kind)) return;
    const memoryDirectory = kind === 'work_consolidation'
      ? workMemoryDir()
      : relationshipMemoryDir();
    const consolidate = kind === 'work_consolidation'
      ? workConsolidate
      : relationshipConsolidate;
    let claimed = false;
    const drain = runConsolidationJobs(
      jobs,
      kind,
      memoryDirectory,
      consolidate,
      shutdownController.signal,
    ).then(value => { claimed = value; })
      .catch(error => console.warn(`[memory] 整合执行失败(${kind}):`, error))
      .finally(() => {
        consolidationDrains.delete(kind);
        if (claimed && consolidationReady(kind)) {
          jobs.enqueueConsolidationIfAbsent(randomUUID(), kind, Date.now());
          queueMicrotask(() => kickConsolidation(kind));
        }
      });
    consolidationDrains.set(kind, drain);
  };

  const scheduleConsolidation = (kind: ConsolidationKind): void => {
    if (!consolidationReady(kind)) return;
    jobs.enqueueConsolidationIfAbsent(randomUUID(), kind, Date.now());
    kickConsolidation(kind);
  };

  const kickExtraction = (kind: MemoryExtractionJobKind): void => {
    if (shutdownController.signal.aborted || extractionDrains.has(kind)) return;
    const drain = runExtractionJobs(jobs, kind, extractTurn, shutdownController.signal)
      .then(stats => {
        if (stats.succeededWithOutput > 0) {
          scheduleConsolidation(
            kind === 'work_extraction'
              ? 'work_consolidation'
              : 'relationship_consolidation',
          );
        }
      })
      .catch(error => console.warn(`[memory] 提取队列执行失败(${kind}):`, error))
      .finally(() => extractionDrains.delete(kind));
    extractionDrains.set(kind, drain);
  };

  const runMaintenance = (
    kind: MemoryMaintenanceJobKind,
    job: NonNullable<ReturnType<MemoryRepo['startMaintenanceIfIdle']>>,
  ): void => {
    if (maintenanceDrains.has(kind)) return;
    const maintain = kind === 'work_maintenance'
      ? () => maintainWorkMemory(workMemoryDir())
      : () => maintainRelationshipMemory(memoryRoot, relationshipMemoryDir());
    const drain = runMaintenanceJob(jobs, job, maintain, shutdownController.signal)
      .catch(error => console.warn(`[memory] 维护执行失败(${kind}):`, error))
      .finally(() => {
        maintenanceDrains.delete(kind);
        kickConsolidation(
          kind === 'work_maintenance'
            ? 'work_consolidation'
            : 'relationship_consolidation',
        );
      });
    maintenanceDrains.set(kind, drain);
  };

  const scheduleMaintenance = (kind: MemoryMaintenanceJobKind): void => {
    if (shutdownController.signal.aborted || maintenanceDrains.has(kind)) return;
    const job = jobs.claimNext(kind, Date.now())
      ?? jobs.startMaintenanceIfIdle(randomUUID(), kind, Date.now());
    if (job) runMaintenance(kind, job);
  };

  const resumeMaintenance = (kind: MemoryMaintenanceJobKind): void => {
    const job = jobs.claimNext(kind, Date.now());
    if (job) runMaintenance(kind, job);
  };

  const composition: MemoryComposition = {
    jobs,
    memoryRoot,
    enqueueTurnExtraction: turnId => {
      const turn = deps.turns.getTurn(turnId);
      try {
        jobs.enqueueExtraction(randomUUID(), 'work_extraction', turnId, Date.now());
        queueMicrotask(() => kickExtraction('work_extraction'));
      } catch (error) {
        console.warn(`[memory] Work 提取入队失败(${turnId}):`, error);
      }
      if (!turn?.characterDirectoryName) return;
      try {
        jobs.enqueueExtraction(randomUUID(), 'relationship_extraction', turnId, Date.now());
        queueMicrotask(() => kickExtraction('relationship_extraction'));
      } catch (error) {
        console.warn(`[memory] Relationship 提取入队失败(${turnId}):`, error);
      }
    },
    start: () => {
      if (started) return;
      started = true;
      jobs.requeueInterrupted();
      kickExtraction('work_extraction');
      kickExtraction('relationship_extraction');
      kickConsolidation('work_consolidation');
      kickConsolidation('relationship_consolidation');
      resumeMaintenance('work_maintenance');
      resumeMaintenance('relationship_maintenance');
      consolidationTimer = setInterval(() => {
        scheduleConsolidation('work_consolidation');
        scheduleConsolidation('relationship_consolidation');
      }, MEMORY_CONSOLIDATION_CHECK_INTERVAL_MS);
      maintenanceTimer = setInterval(() => {
        scheduleMaintenance('work_maintenance');
        scheduleMaintenance('relationship_maintenance');
      }, MEMORY_MAINTENANCE_INTERVAL_MS);
      consolidationTimer.unref();
      maintenanceTimer.unref();
    },
    shutdown: () => {
      shutdownController.abort();
      if (consolidationTimer) clearInterval(consolidationTimer);
      if (maintenanceTimer) clearInterval(maintenanceTimer);
    },
  };
  return composition;
}

function buildMemoryMessages(
  messages: ReturnType<SessionStore['loadMessagesForTurn']>,
): Message[] {
  const projected: Message[] = [];
  for (const message of messages) {
    if (message.kind === 'reminder' || message.kind === 'summary') continue;
    if (message.role === 'user') {
      const text = typeof message.blocks === 'string'
        ? message.blocks
        : message.blocks
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('\n');
      if (text.trim()) projected.push({ role: 'user', content: text });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.blocks)) {
      const content = message.blocks.filter(block => block.type === 'text');
      if (content.length > 0) projected.push({ role: 'assistant', content });
    }
  }
  return projected;
}
