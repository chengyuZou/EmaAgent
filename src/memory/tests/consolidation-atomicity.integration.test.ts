// 测试 Memory 归并在并发追加、节点冲突、事务失败和 ANN 同步失败时不丢证据。

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Database,
  MemoryLazyUpdatesRepo,
  MemoryNodesRepo,
} from '@ema-agent/storage';
import type { EmbeddingSpace } from '@ema-agent/embed';
import type { MemoryDeps } from '../deps.js';
import type { EmbedService } from '../embed/service.js';
import type { EmbeddedText } from '../types.js';
import type { VectorIndex } from '../vector-index/vector-index.js';
import { MemoryCommitCoordinator } from '../tasks/commit-coordinator.js';
import { consolidatePendingNodes } from '../consolidation/consolidatePendingNodes.js';

const SPACE: EmbeddingSpace = {
  id: 'memory-space-v1',
  providerId: 'provider-1',
  model: 'embed-1',
  dim: 2,
  normalization: 'l2',
  revision: 'revision-1',
};
const opened: Database[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()!.close();
});

function vector(values: number[]): Buffer {
  const array = Float32Array.from(values);
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

function createHarness(options: {
  duringModelCall?: (
    nodes: MemoryNodesRepo,
    lazyUpdates: MemoryLazyUpdatesRepo,
  ) => void;
  withEmbedding?: boolean;
  indexUpdate?: () => void;
} = {}) {
  const profileDb = new Database({ memory: true, kind: 'profile' });
  opened.push(profileDb);
  profileDb.migrate();

  const nodes = new MemoryNodesRepo(profileDb.sqlite);
  const lazyUpdates = new MemoryLazyUpdatesRepo(profileDb.sqlite);
  nodes.insert({
    id: 'node-1',
    label: 'Ema',
    nodeType: 'entity',
    description: '旧描述',
    importance: 50,
    embedding: vector([1, 0]),
    embeddingProviderId: SPACE.providerId,
    embeddingModel: SPACE.model,
    embeddingDim: SPACE.dim,
    embeddingNormalization: SPACE.normalization,
    embeddingRevision: SPACE.revision,
    embeddingSpaceId: SPACE.id,
    createdAt: 1,
  });
  lazyUpdates.append({
    id: 'lazy-1',
    nodeId: 'node-1',
    fragment: '第一条新证据',
    createdAt: 2,
  });

  const llmComplete = vi.fn(async () => {
    options.duringModelCall?.(nodes, lazyUpdates);
    return {
      blocks: [{
        type: 'text' as const,
        text: JSON.stringify({
          updated_description: '归并后的描述',
          importance_delta: 5,
        }),
      }],
    };
  });
  const deps = {
    llm: { complete: llmComplete },
    modelBindings: {
      get: () => ({
        providerConfigId: 'provider-1',
        model: 'memory-model',
      }),
    },
    nodes,
    lazyUpdates,
    runProfileTransaction: <T>(work: () => T): T =>
      profileDb.sqlite.transaction(work)(),
  } as unknown as MemoryDeps;
  const embedded: EmbeddedText = {
    embedding: vector([0, 1]),
    providerId: SPACE.providerId,
    model: SPACE.model,
    dim: SPACE.dim,
    space: SPACE,
  };
  const embed = {
    embedOne: vi.fn(async () => options.withEmbedding ? embedded : null),
  } as unknown as EmbedService;
  const nodesIndex = {
    dim: SPACE.dim,
    update: vi.fn(options.indexUpdate ?? (() => undefined)),
    remove: vi.fn(),
  } as unknown as VectorIndex;
  const refreshIndexes = vi.fn(async () => undefined);

  return {
    nodes,
    lazyUpdates,
    refreshIndexes,
    run: () => consolidatePendingNodes({
      memory: deps,
      embed,
      nodesIndex,
      indexSpaceId: SPACE.id,
      commitCoordinator: new MemoryCommitCoordinator(),
      refreshIndexes,
    }, {
      maxNodes: 10,
    }),
  };
}

describe('Memory Consolidation 原子提交', () => {
  it('模型往返期间新到的证据保留，只消费本轮快照', async () => {
    const harness = createHarness({
      duringModelCall: (_nodes, lazyUpdates) => {
        lazyUpdates.append({
          id: 'lazy-2',
          nodeId: 'node-1',
          fragment: '模型调用期间到达的证据',
          createdAt: 3,
        });
      },
    });

    await expect(harness.run()).resolves.toMatchObject({
      consolidated: 1,
      conflicts: 0,
    });

    expect(harness.nodes.findById('node-1')).toMatchObject({
      description: '归并后的描述',
      importance: 55,
      embedding: null,
    });
    expect(harness.lazyUpdates.listByNode('node-1').map(row => row.id))
      .toEqual(['lazy-2']);
  });

  it('模型往返期间节点被更新时 CAS 拒绝旧结果，并保留全部证据', async () => {
    const harness = createHarness({
      duringModelCall: nodes => {
        nodes.updateDescription({
          id: 'node-1',
          description: '并发写入的新描述',
          importanceDelta: 1,
          updatedAt: 10,
        });
      },
    });

    await expect(harness.run()).resolves.toMatchObject({
      consolidated: 0,
      conflicts: 1,
    });

    expect(harness.nodes.findById('node-1')).toMatchObject({
      description: '并发写入的新描述',
      importance: 51,
    });
    expect(harness.lazyUpdates.listByNode('node-1').map(row => row.id))
      .toEqual(['lazy-1']);
  });

  it('精确证据集合不完整时不使用残缺快照覆盖节点', async () => {
    const harness = createHarness({
      duringModelCall: (_nodes, lazyUpdates) => {
        lazyUpdates.deleteByIds(['lazy-1']);
        lazyUpdates.append({
          id: 'lazy-2',
          nodeId: 'node-1',
          fragment: '替代证据',
          createdAt: 3,
        });
      },
    });

    await expect(harness.run()).resolves.toMatchObject({
      consolidated: 0,
      conflicts: 1,
    });
    expect(harness.nodes.findById('node-1')?.description).toBe('旧描述');
    expect(harness.lazyUpdates.listByNode('node-1').map(row => row.id))
      .toEqual(['lazy-2']);
  });

  it('节点 CAS 后删除证据失败时同一事务整体回滚', async () => {
    const harness = createHarness();
    const deleteByIds = harness.lazyUpdates.deleteByIds.bind(harness.lazyUpdates);
    vi.spyOn(harness.lazyUpdates, 'deleteByIds').mockImplementation(ids => {
      deleteByIds(ids);
      throw new Error('injected lazy delete failure');
    });

    await expect(harness.run()).rejects.toThrow('injected lazy delete failure');

    expect(harness.nodes.findById('node-1')).toMatchObject({
      description: '旧描述',
      importance: 50,
    });
    expect(harness.lazyUpdates.listByNode('node-1').map(row => row.id))
      .toEqual(['lazy-1']);
  });

  it('SQLite 提交后 ANN 更新失败会触发完整索引重建', async () => {
    const harness = createHarness({
      withEmbedding: true,
      indexUpdate: () => {
        throw new Error('injected ANN failure');
      },
    });

    await expect(harness.run()).resolves.toMatchObject({
      consolidated: 1,
      conflicts: 0,
    });
    expect(harness.refreshIndexes).toHaveBeenCalledTimes(1);
    expect(harness.nodes.findById('node-1')).toMatchObject({
      description: '归并后的描述',
      embedding_space_id: SPACE.id,
    });
    expect(harness.lazyUpdates.listByNode('node-1')).toEqual([]);
  });
});
