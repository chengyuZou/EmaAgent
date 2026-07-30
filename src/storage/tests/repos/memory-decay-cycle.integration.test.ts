// 测试 Memory 衰减周期迁移、候选筛选与 CAS 更新不会在短时间内重复扣减重要度。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Database,
  MemoryItemsRepo,
  MemoryNodesRepo,
} from '../../index.js';

describe('profile v16 Memory 衰减周期', () => {
  let database: Database;
  let nodes: MemoryNodesRepo;
  let items: MemoryItemsRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    nodes = new MemoryNodesRepo(database.sqlite);
    items = new MemoryItemsRepo(database.sqlite);
    nodes.insert({
      id: 'node-a',
      label: 'Node A',
      nodeType: 'entity',
      description: 'node',
      importance: 50,
      createdAt: 1,
    });
    items.insert({
      id: 'item-a',
      kind: 'project',
      title: 'Item A',
      body: 'item',
      profiles: ['work'],
      importance: 50,
      createdAt: 1,
    });
  });

  afterEach(() => database.close());

  it('首次衰减写入周期，周期截止前不会再次成为候选', () => {
    const nowMs = 40 * 86_400_000;
    const cutoff = nowMs - 30 * 86_400_000;
    const node = nodes.listDecayCandidates(cutoff, cutoff, [], 10)[0];
    const item = items.listDecayCandidates(cutoff, cutoff, nowMs, [], 10)[0];

    expect(node.last_decayed_at).toBeNull();
    expect(item.last_decayed_at).toBeNull();

    database.sqlite.transaction(() => {
      expect(nodes.applyDecayUpdates([{
        id: node.id,
        importance: 40,
        expectedImportance: node.importance,
        expectedLastReferencedAt: node.last_referenced_at,
        expectedLastDecayedAt: node.last_decayed_at,
        updatedAt: nowMs,
      }])).toEqual(['node-a']);
      expect(items.applyDecayUpdates([{
        id: item.id,
        importance: 40,
        expectedImportance: item.importance,
        expectedLastReferencedAt: item.last_referenced_at,
        expectedLastDecayedAt: item.last_decayed_at,
        updatedAt: nowMs,
      }])).toEqual(['item-a']);
    })();

    expect(nodes.listDecayCandidates(cutoff, cutoff, [], 10)).toEqual([]);
    expect(items.listDecayCandidates(cutoff, cutoff, nowMs, [], 10)).toEqual([]);

    const later = nowMs + 31 * 86_400_000;
    const laterCutoff = later - 30 * 86_400_000;
    expect(nodes.listDecayCandidates(laterCutoff, laterCutoff, [], 10))
      .toHaveLength(1);
    expect(items.listDecayCandidates(laterCutoff, laterCutoff, later, [], 10))
      .toHaveLength(1);
    expect(database.currentVersion()).toBe(16);
  });

  it('候选读取后发生引用时，旧 CAS 不会覆盖新的重要度与引用时间', () => {
    const nowMs = 40 * 86_400_000;
    const cutoff = nowMs - 30 * 86_400_000;
    const candidate = nodes.listDecayCandidates(cutoff, cutoff, [], 10)[0];

    nodes.touchReferenced(['node-a'], nowMs);

    expect(nodes.applyDecayUpdates([{
      id: candidate.id,
      importance: 40,
      expectedImportance: candidate.importance,
      expectedLastReferencedAt: candidate.last_referenced_at,
      expectedLastDecayedAt: candidate.last_decayed_at,
      updatedAt: nowMs,
    }])).toEqual([]);
    expect(nodes.findById('node-a')).toMatchObject({
      importance: 50,
      last_referenced_at: nowMs,
      last_decayed_at: null,
    });
  });
});
