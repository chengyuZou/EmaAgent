// 测试 Memory 超预算后的分级降压、保护类保留和 ANN 同步。

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Database,
  MemoryItemsRepo,
  MemoryNodesRepo,
  MemoryStorageRepo,
} from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';
import type { MemoryBackgroundEvent } from '../events.js';
import { enforceMemoryStorageBudget } from '../maintenance/storageBudget.js';
import {
  memoryColdDeleteAfterDaysSetting,
  memoryStorageMaxBytesSetting,
} from '../settings.js';
import { MemoryCommitCoordinator } from '../tasks/commit-coordinator.js';

const DAY_MS = 86_400_000;
const NOW = 200 * DAY_MS;
const opened: Database[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()!.close();
});

describe('Memory 全局逻辑字节预算', () => {
  it('依次清理过期项和冷的零重要度项，并保护用户身份类', async () => {
    const harness = createHarness();
    harness.items.insert({
      id: 'expired',
      kind: 'project',
      title: '过期',
      body: 'x'.repeat(1000),
      profiles: ['chat'],
      importance: 50,
      expiresAt: NOW - 1,
      createdAt: 1,
    });
    harness.nodes.insert({
      id: 'cold-zero',
      label: '冷节点',
      nodeType: 'entity',
      description: 'x'.repeat(1000),
      importance: 0,
      createdAt: 1,
    });
    harness.nodes.insert({
      id: 'protected',
      label: '用户事实',
      nodeType: 'user_fact',
      description: 'x'.repeat(1000),
      importance: 0,
      createdAt: 1,
    });

    const report = await harness.run(1);

    expect(report.expiredItemsDeleted).toBe(1);
    expect(report.coldNodesDeleted).toBe(1);
    expect(harness.items.findById('expired')).toBeUndefined();
    expect(harness.nodes.findById('cold-zero')).toBeUndefined();
    expect(harness.nodes.findById('protected')).toBeDefined();
    expect(harness.removeItem).toHaveBeenCalledWith('expired');
    expect(harness.removeNode).toHaveBeenCalledWith('cold-zero');
    expect(report.pressureRemaining).toBe(true);
  });

  it('正文保留但驱逐冷向量，保护类向量不动且不会立刻触发修复', async () => {
    const harness = createHarness();
    insertEmbeddedNode(harness.nodes, 'cold-vector', 'entity');
    insertEmbeddedNode(harness.nodes, 'protected-vector', 'preference');
    harness.items.insert({
      id: 'cold-item-vector',
      kind: 'project',
      title: '项目',
      body: '正文保留',
      profiles: ['chat'],
      embedding: vector(256),
      embeddingProviderId: 'provider-1',
      embeddingModel: 'embed-1',
      embeddingDim: 256,
      embeddingSpaceId: 'space-1',
      importance: 30,
      createdAt: 1,
    });

    const report = await harness.run(1);

    expect(report.nodeEmbeddingsEvicted).toBe(1);
    expect(report.itemEmbeddingsEvicted).toBe(1);
    expect(harness.nodes.findById('cold-vector')).toMatchObject({
      description: '正文保留',
      embedding: null,
      embedding_evicted_at: NOW,
    });
    expect(harness.items.findById('cold-item-vector')).toMatchObject({
      body: '正文保留',
      embedding: null,
      embedding_evicted_at: NOW,
    });
    expect(harness.nodes.findById('protected-vector')?.embedding).not.toBeNull();
    expect(harness.nodes.countRepairableEmbeddings('space-1')).toBe(0);
    expect(harness.items.countRepairableEmbeddings('space-1', NOW)).toBe(0);
    expect(harness.removeNode).toHaveBeenCalledWith('cold-vector');
    expect(harness.removeItem).toHaveBeenCalledWith('cold-item-vector');
    expect(harness.events.at(-1)).toMatchObject({
      type: 'memory_storage_budget_enforced',
      evictedEmbeddings: 2,
      pressureRemaining: true,
    });
  });

  it('每个有界批次后响应前台取消，不继续清理后续行', async () => {
    const harness = createHarness();
    for (let index = 0; index < 401; index++) {
      harness.items.insert({
        id: `expired-${index}`,
        kind: 'project',
        title: '过期',
        body: 'x'.repeat(100),
        profiles: ['chat'],
        importance: 50,
        expiresAt: NOW - 1,
        createdAt: index + 1,
      });
    }
    const controller = new AbortController();
    setImmediate(() => controller.abort());

    await expect(harness.run(1, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(harness.items.findById('expired-0')).toBeUndefined();
    expect(harness.items.findById('expired-300')).toBeDefined();
    expect(harness.events).toHaveLength(0);
  });
});

describe('Memory 用户设置边界', () => {
  // 模型选择已迁出到 model_bindings(memory-embed/memory-rerank),不再有 settings 校验。

  it('维护期限和存储预算只能落在产品安全范围内', () => {
    expect(memoryColdDeleteAfterDaysSetting.schema.safeParse(90).success).toBe(true);
    expect(memoryColdDeleteAfterDaysSetting.schema.safeParse(1).success).toBe(false);
    expect(memoryStorageMaxBytesSetting.schema.safeParse(64 * 1024 * 1024).success).toBe(true);
    expect(memoryStorageMaxBytesSetting.schema.safeParse(1024).success).toBe(false);
  });
});

function createHarness() {
  const profileDb = new Database({ memory: true, kind: 'profile' });
  opened.push(profileDb);
  profileDb.migrate();
  const nodes = new MemoryNodesRepo(profileDb.sqlite);
  const items = new MemoryItemsRepo(profileDb.sqlite);
  const storage = new MemoryStorageRepo(profileDb.sqlite);
  const events: MemoryBackgroundEvent[] = [];
  const deps = {
    nodes,
    items,
    storage,
    emit: (event: MemoryBackgroundEvent) => events.push(event),
    runProfileTransaction: <T>(work: () => T): T => profileDb.sqlite.transaction(work)(),
  } as unknown as MemoryDeps;
  const removeNode = vi.fn();
  const removeItem = vi.fn();
  const refreshIndexes = vi.fn(async () => undefined);

  return {
    nodes,
    items,
    events,
    removeNode,
    removeItem,
    run: (maxBytes: number, signal?: AbortSignal) => enforceMemoryStorageBudget(
      deps,
      {
        storage: { maxBytes },
        maintenance: {
          decayAfterDays: 30,
          decayAmount: 10,
          coldDeleteAfterDays: 90,
        },
      },
      {
        commitCoordinator: new MemoryCommitCoordinator(),
        removeNodeFromIndex: removeNode,
        removeItemFromIndex: removeItem,
        refreshIndexes,
        nowMs: NOW,
        signal,
      },
    ),
  };
}

function insertEmbeddedNode(
  nodes: MemoryNodesRepo,
  id: string,
  nodeType: 'entity' | 'preference',
): void {
  nodes.insert({
    id,
    label: id,
    nodeType,
    description: '正文保留',
    embedding: vector(256),
    embeddingProviderId: 'provider-1',
    embeddingModel: 'embed-1',
    embeddingDim: 256,
    embeddingSpaceId: 'space-1',
    importance: 30,
    createdAt: 1,
  });
}

function vector(dim: number): Buffer {
  const values = new Float32Array(dim);
  values.fill(1);
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}
