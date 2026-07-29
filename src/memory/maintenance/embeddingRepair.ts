// 修复换 embed 模型后残留的异空间/缺失向量：按批重 embed，先落库再同步索引。
import type { MemoryDeps } from '../deps.js';
import type { EmbedService } from '../embed/service.js';
import type { VectorIndex } from '../vector-index/vector-index.js';
import type { MemoryCommitCoordinator } from '../tasks/commit-coordinator.js';
import type { EmbeddedText } from '../types.js';
import { unpackEmbedding } from '../embed/similarity.js';

const EMBEDDING_REPAIR_CHUNK_SIZE = 32;

export interface EmbeddingRepairReport {
  /** false = 无法确定当前空间（未配置模型或维度未知），本轮跳过。 */
  ran: boolean;
  nodesRepaired: number;
  itemsRepaired: number;
  failed: number;
  /** 本轮结束后仍待修复的总行数（含失败与未轮到的）。 */
  remaining: number;
}

/**
 * 每个维护窗口为节点和条目各修一批：stale 行重 embed 后自动离开待修复集合，
 * 进度隐式推进，断电后下一轮从剩余集合继续，无需游标持久化。
 * Provider 失败只影响当前小批，后续小批仍继续，避免一条坏数据阻塞整张表。
 */
export async function repairStaleEmbeddings(
  deps: MemoryDeps,
  embed: EmbedService,
  opts: {
    batchSize: number;
    nodesIndex: VectorIndex | null;
    itemsIndex: VectorIndex | null;
    indexSpaceId: string | null;
    commitCoordinator: MemoryCommitCoordinator;
    /** ANN 增量同步失败时从 SQLite 重建；索引是派生缓存，不能反向回滚业务数据。 */
    refreshIndexes?: () => Promise<void>;
  },
): Promise<EmbeddingRepairReport> {
  if (!Number.isSafeInteger(opts.batchSize) || opts.batchSize <= 0 || opts.batchSize > 1_000) {
    throw new RangeError('memory.embeddingRepair: batchSize must be between 1 and 1000');
  }

  // 当前空间必须由配置 + catalog 维度解析，与 IndexManager 同一口径，
  // 不能从旧向量反推身份。
  const ref = embed.resolveEmbed();
  if (!ref) return emptyReport(false);
  const dim = deps.getEmbedDim(ref.providerId, ref.model);
  if (!dim) return emptyReport(false);
  const space = embed.currentSpace(dim);
  if (!space) return emptyReport(false);

  const staleNodes = deps.nodes.listStaleEmbeddingPage(space.id, opts.batchSize);
  const staleItems = deps.items.listStaleEmbeddingPage(space.id, Date.now(), opts.batchSize);
  if (staleNodes.length === 0 && staleItems.length === 0) return emptyReport(true);

  // 后台维护不抢占前台模型配额：节点和条目顺序执行，每类内部仍使用批量 API。
  const nodePrepared = await prepareUpdates(
    staleNodes,
    row => `${row.label}: ${row.description}`,
    embed,
    space.id,
    dim,
  );
  const itemPrepared = await prepareUpdates(
    staleItems,
    row => `${row.title}: ${row.body}`,
    embed,
    space.id,
    dim,
  );
  const failed = nodePrepared.failed + itemPrepared.failed;
  const committedNodes: typeof nodePrepared.updates = [];
  const committedItems: typeof itemPrepared.updates = [];

  if (nodePrepared.updates.length > 0 || itemPrepared.updates.length > 0) {
    await opts.commitCoordinator.runExclusive(async () => {
      deps.runProfileTransaction(() => {
        const now = Date.now();
        for (const update of nodePrepared.updates) {
          const { row, embedded } = update;
          const repaired = deps.nodes.repairEmbeddingIfUnchanged({
            id: row.id,
            embedding: embedded.embedding,
            embeddingProviderId: embedded.providerId,
            embeddingModel: embedded.model,
            embeddingDim: embedded.dim,
            embeddingNormalization: embedded.space.normalization,
            embeddingRevision: embedded.space.revision,
            embeddingSpaceId: embedded.space.id,
            updatedAt: now,
            expectedUpdatedAt: row.updated_at,
            targetSpaceId: space.id,
          });
          if (repaired) committedNodes.push(update);
        }
        for (const update of itemPrepared.updates) {
          const { row, embedded } = update;
          const repaired = deps.items.repairEmbeddingIfUnchanged({
            id: row.id,
            embedding: embedded.embedding,
            embeddingProviderId: embedded.providerId,
            embeddingModel: embedded.model,
            embeddingDim: embedded.dim,
            embeddingNormalization: embedded.space.normalization,
            embeddingRevision: embedded.space.revision,
            embeddingSpaceId: embedded.space.id,
            updatedAt: now,
            expectedUpdatedAt: row.updated_at,
            targetSpaceId: space.id,
            repairAt: now,
          });
          if (repaired) committedItems.push(update);
        }
      });

      // 索引是派生缓存：SQLite 提交成功后才更新；空间不匹配的旧索引不写入。
      try {
        if (opts.nodesIndex && opts.indexSpaceId === space.id && opts.nodesIndex.dim === dim) {
          for (const { row, embedded } of committedNodes) {
            opts.nodesIndex.update(row.id, unpackEmbedding(embedded.embedding, embedded.dim));
          }
        }
        if (opts.itemsIndex && opts.indexSpaceId === space.id && opts.itemsIndex.dim === dim) {
          for (const { row, embedded } of committedItems) {
            opts.itemsIndex.update(row.id, unpackEmbedding(embedded.embedding, embedded.dim));
          }
        }
      } catch (error) {
        if (!opts.refreshIndexes) throw error;
        await opts.refreshIndexes();
      }
    });
  }

  const remaining = deps.nodes.countRepairableEmbeddings(space.id)
    + deps.items.countRepairableEmbeddings(space.id, Date.now());
  return {
    ran: true,
    nodesRepaired: committedNodes.length,
    itemsRepaired: committedItems.length,
    failed,
    remaining,
  };
}

interface PreparedUpdate<Row extends { id: string }> {
  row: Row;
  embedded: EmbeddedText;
}

interface PreparedUpdates<Row extends { id: string }> {
  updates: Array<PreparedUpdate<Row>>;
  failed: number;
}

/**
 * 使用小批量保留 Embed API 的吞吐；某批异常或空间身份漂移时跳过该批，
 * 后续批次继续推进，下一次维护窗口会重试失败行。
 */
async function prepareUpdates<Row extends { id: string }>(
  rows: Row[],
  render: (row: Row) => string,
  embed: EmbedService,
  expectedSpaceId: string,
  expectedDim: number,
): Promise<PreparedUpdates<Row>> {
  const updates: Array<PreparedUpdate<Row>> = [];
  let failed = 0;

  for (let offset = 0; offset < rows.length; offset += EMBEDDING_REPAIR_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + EMBEDDING_REPAIR_CHUNK_SIZE);
    try {
      const embeddings = await embed.embedMany(chunk.map(render));
      if (!embeddings || embeddings.length !== chunk.length) {
        failed += chunk.length;
        continue;
      }
      const compatible = embeddings.every(embedded =>
        embedded.space.id === expectedSpaceId
        && embedded.dim === expectedDim
        && embedded.embedding.byteLength === expectedDim * Float32Array.BYTES_PER_ELEMENT,
      );
      if (!compatible) {
        failed += chunk.length;
        continue;
      }
      for (let index = 0; index < chunk.length; index++) {
        updates.push({ row: chunk[index]!, embedded: embeddings[index]! });
      }
    } catch {
      failed += chunk.length;
    }
  }

  return { updates, failed };
}

function emptyReport(ran: boolean): EmbeddingRepairReport {
  return { ran, nodesRepaired: 0, itemsRepaired: 0, failed: 0, remaining: 0 };
}
