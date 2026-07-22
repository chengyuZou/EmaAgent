// 测试 Memory 提取在 profile/data 双数据库间失败后的事务回滚与幂等恢复。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionId, TurnId } from '@ema-agent/ids';
import {
  Database,
  MemoryEdgesRepo,
  MemoryExtractionRunsRepo,
  MemoryItemsRepo,
  MemoryLazyUpdatesRepo,
  MemoryNodesRepo,
  PendingFragmentsRepo,
  SessionNotesRepo,
} from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';
import { runExtractionPipeline } from '../extract/pipeline.js';
import { DEFAULT_MEMORY_SETTINGS } from '../types.js';
import type { EmbedService } from '../embed/service.js';
import { MemoryCommitCoordinator } from '../tasks/commit-coordinator.js';

const sessionId = 'session-b015' as SessionId;
const turnId = 'turn-b015' as TurnId;

interface Harness {
  profileDb: Database;
  dataDb: Database;
  deps: MemoryDeps;
  embed: EmbedService;
  llmComplete: ReturnType<typeof vi.fn>;
  nodes: MemoryNodesRepo;
  edges: MemoryEdgesRepo;
  items: MemoryItemsRepo;
  pending: PendingFragmentsRepo;
  notes: SessionNotesRepo;
  runs: MemoryExtractionRunsRepo;
}

const opened: Database[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()!.close();
});

function count(db: Database, table: string): number {
  return db.sqlite.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
}

function createHarness(): Harness {
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
    .run(sessionId, 'B-015', 1, 1, 1);
  dataDb.sqlite
    .prepare(
      `INSERT INTO turns
         (id, session_id, trigger_type, execution_profile, narrative_policy, status, user_input, started_at)
       VALUES (?, ?, 'userMessage', 'chat', 'auto', 'completed', 'hello', ?)`,
    )
    .run(turnId, sessionId, 1);

  const nodes = new MemoryNodesRepo(profileDb.sqlite);
  const edges = new MemoryEdgesRepo(profileDb.sqlite);
  const lazyUpdates = new MemoryLazyUpdatesRepo(profileDb.sqlite);
  const items = new MemoryItemsRepo(profileDb.sqlite);
  const pending = new PendingFragmentsRepo(dataDb.sqlite);
  const notes = new SessionNotesRepo(dataDb.sqlite);
  const runs = new MemoryExtractionRunsRepo(profileDb.sqlite);

  pending.insert({
    id: 'fragment-b015',
    sessionId,
    turnId,
    role: 'user',
    content: 'Alice works on EmaAgent.',
    at: 1,
    createdAt: 1,
  });

  const llmComplete = vi.fn(async () => ({
    blocks: [{
      type: 'text' as const,
      text: JSON.stringify({
        new_nodes: [
          { label: 'Alice', node_type: 'entity', description: 'A developer', importance: 70 },
          { label: 'EmaAgent', node_type: 'entity', description: 'A desktop agent', importance: 80 },
        ],
        new_edges: [
          { from_label: 'Alice', to_label: 'EmaAgent', relation: 'develops' },
        ],
        memory_items: [
          { kind: 'project', title: 'EmaAgent', body: 'Alice develops EmaAgent.', importance: 80 },
        ],
        session_note_delta: 'Alice is developing EmaAgent.',
      }),
    }],
  }));

  const deps = {
    llm: {
      complete: llmComplete,
    },
    modelBindings: {
      get: () => ({ providerConfigId: 'provider-test', model: 'model-test' }),
    },
    nodes,
    edges,
    lazyUpdates,
    items,
    sessionNotes: notes,
    pendingFragments: pending,
    extractionRuns: runs,
    runProfileTransaction: <T>(work: () => T): T => profileDb.sqlite.transaction(work)(),
    runDataTransaction: <T>(work: () => T): T => dataDb.sqlite.transaction(work)(),
  } as unknown as MemoryDeps;

  const embed = {
    embedMany: vi.fn(async () => null),
  } as unknown as EmbedService;

  return {
    profileDb,
    dataDb,
    deps,
    embed,
    llmComplete,
    nodes,
    edges,
    items,
    pending,
    notes,
    runs,
  };
}

describe('B-015 Memory extraction 事务与跨库恢复', () => {
  it('profile.db 写到一半失败时回滚节点、边、条目与恢复标记', async () => {
    const h = createHarness();
    vi.spyOn(h.items, 'insert').mockImplementation(() => {
      throw new Error('injected item failure');
    });

    await expect(runExtractionPipeline(
      {
        memory: h.deps,
        embed: h.embed,
        settings: DEFAULT_MEMORY_SETTINGS,
        nodesIndex: null,
        itemsIndex: null,
        indexSpaceId: null,
        commitCoordinator: new MemoryCommitCoordinator(),
      },
      { sessionId, mode: 'chat', runId: 'run-rollback', skipConsolidation: true },
    )).rejects.toThrow('injected item failure');

    expect(count(h.profileDb, 'memory_nodes')).toBe(0);
    expect(count(h.profileDb, 'memory_edges')).toBe(0);
    expect(count(h.profileDb, 'memory_items')).toBe(0);
    expect(count(h.profileDb, 'memory_extraction_runs')).toBe(0);
    expect(h.pending.countBySession(sessionId)).toBe(1);
    expect(h.notes.findBySession(sessionId)).toBeUndefined();
  });

  it('data.db 提交失败后按同一 runId 恢复且不重复 profile 写入', async () => {
    const h = createHarness();
    const realDataTransaction = h.deps.runDataTransaction;
    h.deps.runDataTransaction = () => {
      throw new Error('injected data commit failure');
    };

    const pipelineDeps = {
      memory: h.deps,
      embed: h.embed,
      settings: DEFAULT_MEMORY_SETTINGS,
      nodesIndex: null,
      itemsIndex: null,
      indexSpaceId: null,
      commitCoordinator: new MemoryCommitCoordinator(),
    };
    const args = {
      sessionId,
      mode: 'chat' as const,
      runId: 'run-recovery',
      skipConsolidation: true,
    };

    await expect(runExtractionPipeline(pipelineDeps, args))
      .rejects.toThrow('injected data commit failure');

    expect(count(h.profileDb, 'memory_nodes')).toBe(2);
    expect(count(h.profileDb, 'memory_edges')).toBe(1);
    expect(count(h.profileDb, 'memory_items')).toBe(1);
    expect(h.runs.findById(args.runId)).toBeDefined();
    expect(h.pending.countBySession(sessionId)).toBe(1);

    h.deps.runDataTransaction = realDataTransaction;
    await expect(runExtractionPipeline(pipelineDeps, args)).resolves.toMatchObject({
      extractedNodes: 2,
      extractedEdges: 1,
      extractedItems: 1,
    });

    expect(h.llmComplete).toHaveBeenCalledTimes(1);
    expect(count(h.profileDb, 'memory_nodes')).toBe(2);
    expect(count(h.profileDb, 'memory_edges')).toBe(1);
    expect(count(h.profileDb, 'memory_items')).toBe(1);
    expect(h.pending.countBySession(sessionId)).toBe(0);
    expect(h.runs.findById(args.runId)).toBeUndefined();
    expect(JSON.parse(h.notes.findBySession(sessionId)!.body)).toHaveLength(1);
  });
});
