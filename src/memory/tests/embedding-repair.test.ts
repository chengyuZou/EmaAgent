// 测试 stale/缺失向量的按批修复：重 embed、落库、索引同步与失败/跳过语义。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Database,
  MemoryItemsRepo,
  MemoryNodesRepo,
} from '@ema-agent/storage';
import type { EmbeddingSpace } from '@ema-agent/embed';
import type { MemoryDeps } from '../deps.js';
import type { EmbedService } from '../embed/service.js';
import type { VectorIndex } from '../vector-index/vector-index.js';
import type { EmbeddedText } from '../types.js';
import { repairStaleEmbeddings } from '../maintenance/embeddingRepair.js';
import { MemoryCommitCoordinator } from '../tasks/commit-coordinator.js';

const OLD_SPACE = 'space-old';
const NEW_SPACE: EmbeddingSpace = {
  id: 'space-new',
  providerId: 'p-1',
  model: 'embed-1',
  dim: 2,
  normalization: 'l2',
  revision: 'rev-1',
};

const opened: Database[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()!.close();
});

function vector(values: number[]): Buffer {
  const f32 = Float32Array.from(values);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function embedded(text: string): EmbeddedText {
  return {
    embedding: vector(text.includes('Alice') ? [1, 0] : [0, 1]),
    providerId: NEW_SPACE.providerId,
    model: NEW_SPACE.model,
    dim: NEW_SPACE.dim,
    space: NEW_SPACE,
  };
}

function createHarness(opts: {
  embedManyResult?: EmbeddedText[] | null;
  embedMany?: (texts: string[]) => Promise<EmbeddedText[] | null>;
  resolveEmbed?: { providerId: string; model: string } | null;
  dim?: number;
}) {
  const profileDb = new Database({ memory: true, kind: 'profile' });
  opened.push(profileDb);
  profileDb.migrate();

  const nodes = new MemoryNodesRepo(profileDb.sqlite);
  const items = new MemoryItemsRepo(profileDb.sqlite);

  // 旧空间向量节点 + 从未嵌入的条目 + 已过期的旧空间条目。
  nodes.insert({
    id: 'node-stale',
    label: 'Alice',
    nodeType: 'entity',
    description: 'A developer',
    embedding: vector([0.5, 0.5]),
    embeddingProviderId: 'p-old',
    embeddingModel: 'embed-old',
    embeddingDim: 2,
    embeddingNormalization: 'l2',
    embeddingRevision: 'rev-0',
    embeddingSpaceId: OLD_SPACE,
    createdAt: 1,
  });
  items.insert({
    id: 'item-no-embed',
    kind: 'project',
    title: 'EmaAgent',
    body: 'A desktop agent',
    profiles: ['chat'],
    createdAt: 1,
  });
  items.insert({
    id: 'item-expired',
    kind: 'project',
    title: 'Expired',
    body: 'old news',
    profiles: ['chat'],
    embedding: vector([0.5, 0.5]),
    embeddingProviderId: 'p-old',
    embeddingModel: 'embed-old',
    embeddingDim: 2,
    embeddingSpaceId: OLD_SPACE,
    expiresAt: 1, // 已过期
    createdAt: 1,
  });

  const embed = {
    resolveEmbed: () => opts.resolveEmbed !== undefined
      ? opts.resolveEmbed
      : { providerId: NEW_SPACE.providerId, model: NEW_SPACE.model },
    currentSpace: () => NEW_SPACE,
    embedMany: vi.fn(opts.embedMany ?? (async (texts: string[]) =>
      opts.embedManyResult !== undefined ? opts.embedManyResult : texts.map(embedded))),
  } as unknown as EmbedService;

  const deps = {
    nodes,
    items,
    getEmbedDim: () => opts.dim ?? NEW_SPACE.dim,
    runProfileTransaction: <T>(work: () => T): T => profileDb.sqlite.transaction(work)(),
  } as unknown as MemoryDeps;

  const nodesIndex = { dim: 2, update: vi.fn() } as unknown as VectorIndex;
  const itemsIndex = { dim: 2, update: vi.fn() } as unknown as VectorIndex;
  const refreshIndexes = vi.fn(async () => undefined);

  return {
    nodes,
    items,
    embed,
    deps,
    nodesIndex,
    itemsIndex,
    sweep: (signal?: AbortSignal) => repairStaleEmbeddings(deps, embed, {
      batchSize: 10,
      nodesIndex,
      itemsIndex,
      indexSpaceId: NEW_SPACE.id,
      commitCoordinator: new MemoryCommitCoordinator(),
      refreshIndexes,
      signal,
    }),
    refreshIndexes,
  };
}

describe('R11 stale embedding 修复扫描', () => {
  it('旧空间节点与缺失向量条目被重 embed，落库并同步索引；过期条目不修', async () => {
    const h = createHarness({});

    const report = await h.sweep();

    expect(report).toEqual({
      ran: true,
      nodesRepaired: 1,
      itemsRepaired: 1,
      failed: 0,
      remaining: 0,
    });

    const node = h.nodes.findById('node-stale')!;
    expect(node.embedding_space_id).toBe(NEW_SPACE.id);
    expect(node.embedding_model).toBe(NEW_SPACE.model);
    const item = h.items.findById('item-no-embed')!;
    expect(item.embedding).not.toBeNull();
    expect(item.embedding_space_id).toBe(NEW_SPACE.id);

    // 过期条目在清理路径上，不重嵌也不占剩余量。
    const expired = h.items.findById('item-expired')!;
    expect(expired.embedding_space_id).toBe(OLD_SPACE);

    expect(h.nodesIndex.update).toHaveBeenCalledWith('node-stale', expect.any(Float32Array));
    expect(h.itemsIndex.update).toHaveBeenCalledWith('item-no-embed', expect.any(Float32Array));

    // 修完后第二轮是空扫。
    expect(await h.sweep()).toEqual({
      ran: true, nodesRepaired: 0, itemsRepaired: 0, failed: 0, remaining: 0,
    });
  });

  it('embed 整体失败时该批计入失败，不写库不同步索引，剩余量保留', async () => {
    const h = createHarness({ embedManyResult: null });

    const report = await h.sweep();

    expect(report).toEqual({
      ran: true,
      nodesRepaired: 0,
      itemsRepaired: 0,
      failed: 2,
      remaining: 2,
    });
    expect(h.nodes.findById('node-stale')!.embedding_space_id).toBe(OLD_SPACE);
    expect(h.nodesIndex.update).not.toHaveBeenCalled();
  });

  it('未配置 embed 模型或维度未知时跳过本轮', async () => {
    const noModel = createHarness({ resolveEmbed: null });
    expect((await noModel.sweep()).ran).toBe(false);

    const noDim = createHarness({ dim: 0 });
    const report = await noDim.sweep();
    expect(report.ran).toBe(false);
    expect(noDim.nodes.findById('node-stale')!.embedding_space_id).toBe(OLD_SPACE);
  });

  it('Embed 等待期间行被并发更新时 CAS 拒绝旧文本向量', async () => {
    const h = createHarness({});
    vi.mocked(h.embed.embedMany).mockImplementation(async (texts: string[]) => {
      if (texts.some(text => text.includes('Alice'))) {
        h.nodes.updateDescription({
          id: 'node-stale',
          description: 'A newer description',
          updatedAt: 2,
        });
      }
      return texts.map(embedded);
    });

    const report = await h.sweep();

    expect(report.nodesRepaired).toBe(0);
    expect(report.itemsRepaired).toBe(1);
    expect(report.remaining).toBe(1);
    expect(h.nodes.findById('node-stale')!.description).toBe('A newer description');
    expect(h.nodes.findById('node-stale')!.embedding_space_id).toBe(OLD_SPACE);
    expect(h.nodesIndex.update).not.toHaveBeenCalled();
  });

  it('Provider 返回异空间向量时整批拒绝且不虚报 repaired', async () => {
    const wrongSpace = { ...NEW_SPACE, id: 'space-unexpected' };
    const h = createHarness({
      embedMany: async texts => texts.map(text => ({
        ...embedded(text),
        space: wrongSpace,
      })),
    });

    const report = await h.sweep();

    expect(report).toMatchObject({
      nodesRepaired: 0,
      itemsRepaired: 0,
      failed: 2,
      remaining: 2,
    });
    expect(h.nodes.findById('node-stale')!.embedding_space_id).toBe(OLD_SPACE);
    expect(h.items.findById('item-no-embed')!.embedding).toBeNull();
  });

  it('一种数据的 Embed 异常不阻塞另一种数据继续修复', async () => {
    const h = createHarness({
      embedMany: async texts => {
        if (texts.some(text => text.includes('Alice'))) throw new Error('bad node batch');
        return texts.map(embedded);
      },
    });

    const report = await h.sweep();

    expect(report).toMatchObject({
      nodesRepaired: 0,
      itemsRepaired: 1,
      failed: 1,
      remaining: 1,
    });
  });

  it('SQLite 已提交但 ANN 增量同步失败时立即从源数据重建索引', async () => {
    const h = createHarness({});
    vi.mocked(h.nodesIndex.update).mockImplementation(() => {
      throw new Error('native index update failed');
    });

    const report = await h.sweep();

    expect(report.nodesRepaired).toBe(1);
    expect(report.itemsRepaired).toBe(1);
    expect(h.refreshIndexes).toHaveBeenCalledOnce();
  });

  it('前台 Turn 在 Embed 等待期间开始时取消维护且不提交旧批次', async () => {
    const controller = new AbortController();
    const h = createHarness({
      embedMany: async texts => {
        controller.abort();
        return texts.map(embedded);
      },
    });

    await expect(h.sweep(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(h.nodes.findById('node-stale')!.embedding_space_id).toBe(OLD_SPACE);
    expect(h.items.findById('item-no-embed')!.embedding).toBeNull();
    expect(h.nodesIndex.update).not.toHaveBeenCalled();
    expect(h.itemsIndex.update).not.toHaveBeenCalled();
  });
});
