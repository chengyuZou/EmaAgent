// 测试提取流水线端到端的 L0 节点溯源登记：新建节点与 lazy update 路径都记录来源 Session/Turn。
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
import { DEFAULT_MEMORY_SETTINGS } from '../types.js';
import type { EmbedService } from '../embed/service.js';
import { MemoryCommitCoordinator } from '../tasks/commit-coordinator.js';

const sessionId = 'session-src' as SessionId;
const turn1 = 'turn-src-1' as TurnId;
const turn2 = 'turn-src-2' as TurnId;

const opened: Database[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()!.close();
});

function createHarness(llmOutputs: unknown[]) {
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
    .run(sessionId, 'R7', 1, 1, 1);
  const insertTurn = dataDb.sqlite.prepare(
    `INSERT INTO turns
       (id, session_id, trigger_type, execution_profile, narrative_policy, status, user_input, started_at)
     VALUES (?, ?, 'userMessage', 'chat', 'auto', 'completed', 'hello', ?)`,
  );
  insertTurn.run(turn1, sessionId, 1);
  insertTurn.run(turn2, sessionId, 2);

  const nodeSources = new MemoryNodeSourcesRepo(profileDb.sqlite);
  const pending = new PendingFragmentsRepo(dataDb.sqlite);

  const llmComplete = vi.fn();
  for (const output of llmOutputs) {
    llmComplete.mockImplementationOnce(async () => ({
      blocks: [{ type: 'text' as const, text: JSON.stringify(output) }],
    }));
  }

  const deps = {
    llm: { complete: llmComplete },
    modelBindings: { get: () => ({ providerConfigId: 'provider-test', model: 'model-test' }) },
    nodes: new MemoryNodesRepo(profileDb.sqlite),
    edges: new MemoryEdgesRepo(profileDb.sqlite),
    lazyUpdates: new MemoryLazyUpdatesRepo(profileDb.sqlite),
    nodeSources,
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

  return { nodeSources, pending, pipelineDeps };
}

async function runOnce(
  harness: ReturnType<typeof createHarness>,
  runId: string,
  turnId: TurnId,
  fragmentId: string,
): Promise<void> {
  harness.pending.insert({
    id: fragmentId,
    sessionId,
    turnId,
    role: 'user',
    content: 'Alice works on EmaAgent.',
    at: 1,
    createdAt: 1,
  });
  await runExtractionPipeline(harness.pipelineDeps, {
    sessionId,
    executionProfile: 'chat',
    runId,
    skipConsolidation: true,
  });
}

describe('R7 Memory L0 节点溯源链', () => {
  it('新建节点登记来源 Session/Turn，lazy update 路径为既有节点累积新来源', async () => {
    const harness = createHarness([
      {
        new_nodes: [
          { label: 'Alice', node_type: 'entity', description: 'A developer', importance: 70, evidence_quote: 'Alice works on EmaAgent.' },
        ],
        new_edges: [],
        memory_items: [],
        session_note_delta: '',
      },
      {
        // 第二次提取命中同名节点：走 lazy update，不新建。
        new_nodes: [
          { label: 'Alice', node_type: 'entity', description: 'A developer who likes cats', importance: 75, evidence_quote: 'Alice works on EmaAgent.' },
        ],
        new_edges: [],
        memory_items: [],
        session_note_delta: '',
      },
    ]);

    await runOnce(harness, 'run-src-1', turn1, 'fragment-src-1');

    const alice = harness.pipelineDeps.memory.nodes.findByLabelAndType('Alice', 'entity')!;
    expect(harness.nodeSources.listByNode(alice.id)).toEqual([
      { node_id: alice.id, source_session_id: sessionId, source_turn_id: turn1, created_at: expect.any(Number) },
    ]);

    await runOnce(harness, 'run-src-2', turn2, 'fragment-src-2');

    const sources = harness.nodeSources.listByNode(alice.id);
    expect(sources.map((s) => s.source_turn_id)).toEqual([turn1, turn2]);
    // 同 (node, session, turn) 重复登记是 no-op：两轮各一条。
    expect(sources).toHaveLength(2);
  });

  it('不同节点各自登记来源，互不串扰', async () => {
    const harness = createHarness([
      {
        new_nodes: [
          { label: 'Alice', node_type: 'entity', description: 'A developer', importance: 70, evidence_quote: 'Alice works on EmaAgent.' },
          { label: 'EmaAgent', node_type: 'entity', description: 'A desktop agent', importance: 80, evidence_quote: 'Alice works on EmaAgent.' },
        ],
        new_edges: [],
        memory_items: [],
        session_note_delta: '',
      },
    ]);

    await runOnce(harness, 'run-src-3', turn1, 'fragment-src-3');

    const alice = harness.pipelineDeps.memory.nodes.findByLabelAndType('Alice', 'entity')!;
    const ema = harness.pipelineDeps.memory.nodes.findByLabelAndType('EmaAgent', 'entity')!;
    expect(harness.nodeSources.listByNode(alice.id).map((s) => s.source_turn_id)).toEqual([turn1]);
    expect(harness.nodeSources.listByNode(ema.id).map((s) => s.source_turn_id)).toEqual([turn1]);
    expect(harness.nodeSources.listByNodes([alice.id, ema.id])).toHaveLength(2);
  });
});
