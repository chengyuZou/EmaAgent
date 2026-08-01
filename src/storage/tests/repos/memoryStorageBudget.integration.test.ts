// 测试 Memory 逻辑字节核算、保护类候选过滤和显式向量驱逐标记。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../database/database.js';
import { MemoryItemsRepo } from '../../repos/profile/memory-items.js';
import { MemoryNodesRepo } from '../../repos/profile/memory-nodes.js';
import { MemoryStorageRepo } from '../../repos/profile/memoryStorage.js';

const EMBEDDING_SPACE = 'memory-space-v1';
const DAY_MS = 86_400_000;

describe('Memory 存储预算 Repository', () => {
  let database: Database;
  let nodes: MemoryNodesRepo;
  let items: MemoryItemsRepo;
  let storage: MemoryStorageRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    nodes = new MemoryNodesRepo(database.sqlite);
    items = new MemoryItemsRepo(database.sqlite);
    storage = new MemoryStorageRepo(database.sqlite);
  });

  afterEach(() => {
    database.close();
  });

  it('按 UTF-8 与 BLOB 载荷核算逻辑字节，驱逐后载荷下降', () => {
    nodes.insert({
      id: 'node-bytes',
      label: '中文',
      nodeType: 'entity',
      description: '长期记忆',
      embedding: vector(256),
      embeddingProviderId: 'provider-1',
      embeddingModel: 'embed-1',
      embeddingDim: 256,
      embeddingSpaceId: EMBEDDING_SPACE,
      createdAt: 1,
    });

    const before = storage.logicalFootprint();
    expect(before.nodesBytes).toBeGreaterThan(1024);
    expect(before.totalBytes).toBe(
      before.nodesBytes
      + before.edgesBytes
      + before.lazyUpdatesBytes
      + before.nodeSourcesBytes
      + before.itemsBytes,
    );

    expect(storage.evictNodeEmbeddings(['node-bytes'], 100)).toBe(1);
    const after = storage.logicalFootprint();
    expect(after.totalBytes).toBeLessThan(before.totalBytes);
    expect(nodes.findById('node-bytes')).toMatchObject({
      embedding: null,
      embedding_evicted_at: 100,
    });
  });

  it('候选查询排除保护类，并按过期、零重要度和冷向量区分层级', () => {
    const old = DAY_MS;
    const now = 200 * DAY_MS;
    const cutoff = 100 * DAY_MS;

    insertNode('node-protected', 'user_fact', 0, old);
    insertNode('node-zero', 'entity', 0, old);
    insertNode('node-cold-vector', 'event', 30, old);
    insertItem('item-protected', 'user', 0, old);
    insertItem('item-zero', 'project', 0, old);
    insertItem('item-cold-vector', 'reference', 30, old);
    insertItem('item-expired', 'project', 50, old, now - 1);

    expect(storage.listExpiredItemIds(now, 20)).toEqual(['item-expired']);
    expect(storage.listColdZeroImportanceNodeIds(
      cutoff,
      ['user_fact', 'preference', 'relationship'],
      20,
    )).toEqual(['node-zero']);
    expect(storage.listColdZeroImportanceItemIds(
      cutoff,
      ['user', 'feedback'],
      20,
    )).toEqual(['item-zero']);
    expect(storage.listColdEmbeddedNodeIds(
      cutoff,
      ['user_fact', 'preference', 'relationship'],
      20,
    )).toEqual(['node-zero', 'node-cold-vector']);
    expect(storage.listColdEmbeddedItemIds(
      now,
      cutoff,
      ['user', 'feedback'],
      20,
    )).toEqual(['item-zero', 'item-cold-vector']);
  });

  it('预算驱逐不进入修复扫描，内容更新后才重新进入', () => {
    insertNode('node-evicted', 'entity', 50, 1);
    insertItem('item-evicted', 'project', 50, 1);

    storage.evictNodeEmbeddings(['node-evicted'], 10);
    storage.evictItemEmbeddings(['item-evicted'], 10);
    expect(nodes.countRepairableEmbeddings(EMBEDDING_SPACE)).toBe(0);
    expect(items.countRepairableEmbeddings(EMBEDDING_SPACE, 20)).toBe(0);

    nodes.updateDescription({
      id: 'node-evicted',
      description: '内容已经变化',
      updatedAt: 20,
    });
    items.updateBody({
      id: 'item-evicted',
      body: '条目内容已经变化',
      importance: 50,
      updatedAt: 20,
    });

    expect(nodes.findById('node-evicted')?.embedding_evicted_at).toBeNull();
    expect(items.findById('item-evicted')?.embedding_evicted_at).toBeNull();
    expect(nodes.countRepairableEmbeddings(EMBEDDING_SPACE)).toBe(1);
    expect(items.countRepairableEmbeddings(EMBEDDING_SPACE, 21)).toBe(1);
  });

  function insertNode(
    id: string,
    nodeType: 'user_fact' | 'entity' | 'event',
    importance: number,
    createdAt: number,
  ): void {
    nodes.insert({
      id,
      label: id,
      nodeType,
      description: id,
      embedding: vector(4),
      embeddingProviderId: 'provider-1',
      embeddingModel: 'embed-1',
      embeddingDim: 4,
      embeddingSpaceId: EMBEDDING_SPACE,
      importance,
      createdAt,
    });
  }

  function insertItem(
    id: string,
    kind: 'user' | 'project' | 'reference',
    importance: number,
    createdAt: number,
    expiresAt?: number,
  ): void {
    items.insert({
      id,
      kind,
      title: id,
      body: id,
      profiles: ['chat'],
      embedding: vector(4),
      embeddingProviderId: 'provider-1',
      embeddingModel: 'embed-1',
      embeddingDim: 4,
      embeddingSpaceId: EMBEDDING_SPACE,
      importance,
      expiresAt,
      createdAt,
    });
  }
});

function vector(dim: number): Buffer {
  const values = new Float32Array(dim);
  values.fill(1);
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}
