// 测试提取流水线在租约丢失时的三个提交关闸：profile 前、data 前与 consolidation 前。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionId, TurnId } from '@ema-agent/ids';
import {
  Database,
  MemoryEdgesRepo,
  MemoryExtractionRunsRepo,
  MemoryItemsRepo,
  MemoryLazyUpdatesRepo,
  MemoryNodesRepo,
  MemoryNodeSourcesRepo,
  PendingFragmentsRepo,
  SessionNotesRepo,
} from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';
import { runExtractionPipeline } from '../extract/pipeline.js';
import { MemoryLeaseLostError } from '../errors.js';
import { DEFAULT_MEMORY_SETTINGS } from '../types.js';
import type { EmbedService } from '../embed/service.js';
import { MemoryCommitCoordinator } from '../tasks/commit-coordinator.js';

const sessionId = 'session-lease' as SessionId;
const turnId = 'turn-lease' as TurnId;

const opened: Database[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()!.close();
});

function count(db: Database, table: string): number {
  return db.sqlite.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
}

function createHarness() {
  const profileDb = new Database({ memory: true, kind: 'profile' });
  const dataDb = new Database({ memory: true, kind: 'data' });
  opened.push(profileDb, dataDb);
  profileDb.migrate();
  dataDb.migrate();

  dataDb.sqlite
    .prepare(
      `INSERT INTO sessions
         (id, title, last_activity_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sessionId, 'R11', 1, 1, 1);
  dataDb.sqlite
    .prepare(
      `INSERT INTO turns
         (id, session_id, trigger_type, execution_profile, narrative_policy, status, user_input, started_at)
       VALUES (?, ?, 'userMessage', 'chat', 'auto', 'completed', 'hello', ?)`,
    )
    .run(turnId, sessionId, 1);

  const pending = new PendingFragmentsRepo(dataDb.sqlite);
  pending.insert({
    id: 'fragment-lease',
    sessionId,
    turnId,
    role: 'user',
    content: 'Alice works on EmaAgent.',
    at: 1,
    createdAt: 1,
  });

  const deps = {
    llm: {
      complete: vi.fn(async () => ({
        blocks: [{
          type: 'text' as const,
          text: JSON.stringify({
            new_nodes: [
              { label: 'Alice', node_type: 'entity', description: 'A developer', importance: 70, evidence_quote: 'Alice works on EmaAgent.' },
            ],
            new_edges: [],
            memory_items: [],
            session_note_delta: 'Alice is developing EmaAgent.',
          }),
        }],
      })),
    },
    modelBindings: { get: () => ({ providerConfigId: 'provider-test', model: 'model-test' }) },
    nodes: new MemoryNodesRepo(profileDb.sqlite),
    edges: new MemoryEdgesRepo(profileDb.sqlite),
    lazyUpdates: new MemoryLazyUpdatesRepo(profileDb.sqlite),
    nodeSources: new MemoryNodeSourcesRepo(profileDb.sqlite),
    items: new MemoryItemsRepo(profileDb.sqlite),
    sessionNotes: new SessionNotesRepo(dataDb.sqlite),
    pendingFragments: pending,
    extractionRuns: new MemoryExtractionRunsRepo(profileDb.sqlite),
    runProfileTransaction: <T>(work: () => T): T => profileDb.sqlite.transaction(work)(),
    runDataTransaction: <T>(work: () => T): T => dataDb.sqlite.transaction(work)(),
  } as unknown as MemoryDeps;

  const pipelineDeps = {
    memory: deps,
    embed: { embedMany: vi.fn(async () => null) } as unknown as EmbedService,
    settings: DEFAULT_MEMORY_SETTINGS,
    nodesIndex: null,
    itemsIndex: null,
    indexSpaceId: null,
    commitCoordinator: new MemoryCommitCoordinator(),
  };

  return { profileDb, dataDb, deps, pipelineDeps, pending };
}

describe('R11 租约丢失提交关闸', () => {
  it('闸门①：profile 提交前租约已丢，一个字节都不写', async () => {
    const h = createHarness();

    await expect(runExtractionPipeline(h.pipelineDeps, {
      sessionId,
      executionProfile: 'chat',
      runId: 'run-lease-1',
      skipConsolidation: true,
      isLeaseValid: () => false,
    })).rejects.toThrow(MemoryLeaseLostError);

    expect(count(h.profileDb, 'memory_nodes')).toBe(0);
    expect(count(h.profileDb, 'memory_node_sources')).toBe(0);
    expect(count(h.profileDb, 'memory_extraction_runs')).toBe(0);
    expect(h.pending.countBySession(sessionId)).toBe(1);
    expect(h.deps.sessionNotes.findBySession(sessionId)).toBeUndefined();
  });

  it('闸门②：profile 提交后租约丢失，data 不写且恢复标记保留；新 Worker 重试只补 data', async () => {
    const h = createHarness();
    let valid = true;
    // profile 事务内最后一个动作是写恢复标记；此后模拟租约易主。
    const realInsert = h.deps.extractionRuns.insert.bind(h.deps.extractionRuns);
    vi.spyOn(h.deps.extractionRuns, 'insert').mockImplementation((row) => {
      realInsert(row);
      valid = false;
    });

    await expect(runExtractionPipeline(h.pipelineDeps, {
      sessionId,
      executionProfile: 'chat',
      runId: 'run-lease-2',
      skipConsolidation: true,
      isLeaseValid: () => valid,
    })).rejects.toThrow(MemoryLeaseLostError);

    // profile 已落库，data 未动：新 Worker 靠恢复标记续跑。
    expect(count(h.profileDb, 'memory_nodes')).toBe(1);
    expect(count(h.profileDb, 'memory_extraction_runs')).toBe(1);
    expect(h.pending.countBySession(sessionId)).toBe(1);
    expect(h.deps.sessionNotes.findBySession(sessionId)).toBeUndefined();

    await expect(runExtractionPipeline(h.pipelineDeps, {
      sessionId,
      executionProfile: 'chat',
      runId: 'run-lease-2',
      skipConsolidation: true,
      isLeaseValid: () => true,
    })).resolves.toMatchObject({ extractedNodes: 1 });

    // note 只追加一次：闸门拦住了迟到方的重复提交。
    expect(JSON.parse(h.deps.sessionNotes.findBySession(sessionId)!.body)).toHaveLength(1);
    expect(h.pending.countBySession(sessionId)).toBe(0);
    expect(count(h.profileDb, 'memory_extraction_runs')).toBe(0);
  });

  it('闸门③：data 提交后租约丢失，consolidation 不排水', async () => {
    const h = createHarness();
    // 预置一个有待归并 fragment 的节点，让 consolidation 有活可干。
    h.deps.nodes.insert({
      id: 'node-alice',
      label: 'Alice',
      nodeType: 'entity',
      description: 'A developer',
      createdAt: 1,
    });
    h.deps.lazyUpdates.append({
      id: 'lazy-1',
      nodeId: 'node-alice',
      fragment: 'likes cats',
      createdAt: 1,
    });

    let valid = true;
    const realDelete = h.deps.extractionRuns.delete.bind(h.deps.extractionRuns);
    vi.spyOn(h.deps.extractionRuns, 'delete').mockImplementation((runId) => {
      realDelete(runId);
      valid = false;
    });

    await expect(runExtractionPipeline(h.pipelineDeps, {
      sessionId,
      executionProfile: 'chat',
      runId: 'run-lease-3',
      skipConsolidation: false,
      isLeaseValid: () => valid,
    })).rejects.toThrow(MemoryLeaseLostError);

    // data 阶段已完成，但 lazy fragment 没有被另一个 Worker 的任务排水：
    // 预置的 lazy-1 与本次提取新追加的都原样保留。
    expect(h.pending.countBySession(sessionId)).toBe(0);
    expect(h.deps.lazyUpdates.listByNode('node-alice')).toHaveLength(2);
  });

  it('未配置 Memory 模型时也必须先验租约，旧 Worker 不得清空 pending', async () => {
    const h = createHarness();
    h.deps.modelBindings.get = () => undefined;

    await expect(runExtractionPipeline(h.pipelineDeps, {
      sessionId,
      executionProfile: 'chat',
      runId: 'run-no-model',
      skipConsolidation: true,
      isLeaseValid: () => false,
    })).rejects.toThrow(MemoryLeaseLostError);

    expect(h.pending.countBySession(sessionId)).toBe(1);
  });

  it('空 pending 的恢复标记清理也受租约保护', async () => {
    const h = createHarness();
    h.pending.clearBySession(sessionId);
    h.deps.extractionRuns.insert({
      runId: 'run-recovery-cleanup',
      sessionId,
      sourceTurnId: turnId,
      noteDelta: 'already committed',
      nodesCount: 1,
      edgesCount: 0,
      itemsCount: 0,
      lazyUpdatesCount: 0,
      committedAt: 1,
    });

    await expect(runExtractionPipeline(h.pipelineDeps, {
      sessionId,
      executionProfile: 'chat',
      runId: 'run-recovery-cleanup',
      skipConsolidation: true,
      isLeaseValid: () => false,
    })).rejects.toThrow(MemoryLeaseLostError);

    expect(h.deps.extractionRuns.findById('run-recovery-cleanup')).toBeDefined();
  });
});
