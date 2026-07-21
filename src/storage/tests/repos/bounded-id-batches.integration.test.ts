import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSqliteIdBatches,
  Database,
  MemoryEdgesRepo,
  MemoryItemsRepo,
  MemoryLazyUpdatesRepo,
  MemoryNodesRepo,
  SQLITE_ID_BATCH_HARD_LIMIT,
  sqliteVariableLimit,
} from '../../index.js';

describe('N-010 SQLite ID 安全分批', () => {
  let database: Database;
  let nodes: MemoryNodesRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    nodes = new MemoryNodesRepo(database.sqlite);
    for (const id of ['node-a', 'node-b']) {
      nodes.insert({
        id,
        label: id,
        nodeType: 'entity',
        description: id,
        createdAt: 1,
      });
    }
  });

  afterEach(() => database.close());

  it('每批同时受 400 ID 硬上限和 SQLite 参数上限约束', () => {
    const ids = [...makeIds('id', 1_205), 'id-0001', 'id-0002'];
    const batches = createSqliteIdBatches(database.sqlite, ids, {
      occurrencesPerId: 2,
      fixedParameterCount: 1,
    });
    const variableLimit = sqliteVariableLimit(database.sqlite);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toHaveLength(1_205);
    expect(Math.max(...batches.map((batch) => batch.length)))
      .toBeLessThanOrEqual(SQLITE_ID_BATCH_HARD_LIMIT);
    expect(batches.every((batch) => batch.length * 2 + 1 <= variableLimit))
      .toBe(true);
  });

  it('Edge 跨批查询去重并全局排序，批量 touch 不会部分遗漏', () => {
    const edges = new MemoryEdgesRepo(database.sqlite);
    edges.upsert({
      id: 'edge-ab',
      fromNodeId: 'node-a',
      toNodeId: 'node-b',
      relation: 'related',
      at: 1,
    });
    edges.upsert({
      id: 'ignored-conflict-id',
      fromNodeId: 'node-a',
      toNodeId: 'node-b',
      relation: 'related',
      at: 2,
    });
    const nodeIds = makeIds('missing-node', 1_200);
    nodeIds[0] = 'node-a';
    nodeIds[800] = 'node-b';

    expect(edges.listForNodes(nodeIds)).toEqual([
      expect.objectContaining({ id: 'edge-ab', mention_count: 2 }),
    ]);

    const edgeIds = makeIds('missing-edge', 1_200);
    edgeIds[1_100] = 'edge-ab';
    edges.touchReferenced(edgeIds, 99);
    expect(edges.listForNodes(['node-a'])[0]?.last_referenced_at).toBe(99);
  });

  it('Node、Item 和 LazyUpdate 的大批量操作全部完成', () => {
    const requestedNodeIds = makeIds('missing-node', 1_200);
    requestedNodeIds[401] = 'node-a';
    requestedNodeIds[1_001] = 'node-b';
    nodes.touchReferenced(requestedNodeIds, 50);
    expect(nodes.findById('node-a')?.last_referenced_at).toBe(50);
    expect(nodes.findById('node-b')?.last_referenced_at).toBe(50);

    const items = new MemoryItemsRepo(database.sqlite);
    for (const id of ['item-a', 'item-b']) {
      items.insert({
        id,
        kind: 'reference',
        title: id,
        body: id,
        modes: ['chat'],
        createdAt: 1,
      });
    }
    const requestedItemIds = makeIds('missing-item', 1_200);
    requestedItemIds[402] = 'item-a';
    requestedItemIds[1_002] = 'item-b';
    items.touchReferenced(requestedItemIds, 60, {
      maxBoost: 10,
      halfLifeDays: 30,
      saturationStart: 80,
      saturationSlope: 0.5,
    });
    expect(items.findById('item-a')?.last_referenced_at).toBe(60);
    expect(items.findById('item-b')?.last_referenced_at).toBe(60);

    const lazy = new MemoryLazyUpdatesRepo(database.sqlite);
    const updateIds = makeIds('update', 1_001);
    database.sqlite.transaction(() => {
      for (const id of updateIds) {
        lazy.append({ id, nodeId: 'node-a', fragment: id, createdAt: 1 });
      }
    })();
    lazy.deleteByIds([...updateIds, updateIds[0]!]);
    expect(lazy.countAll()).toBe(0);
  });
});

function makeIds(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index).padStart(4, '0')}`,
  );
}
