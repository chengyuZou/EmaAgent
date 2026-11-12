import type {
  NarrativeChunksRepo,
  NarrativeChunkVectorRow,
  NarrativeGraphRepo,
} from '@ema-agent/storage';
import { RELATED_CHUNK_NUMBER } from '../constants.js';
import { rankVectors } from '../vectors.js';

/**
 * .5 时取最近的偶数, 与 LightRAG 的 Python round 一致.
 * Math.round 在此处会改变部分来源组分到的块数.
 */
function roundLikePython(value: number): number {
  const floor = Math.floor(value);
  if (value - floor === 0.5) {
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Math.round(value);
}

// 没有可排名的向量时, 按召回组的先后分配 5 到 1 个块; 某组不足的数量补给前面尚有剩余的组.
function pickByWeight(groups: readonly (readonly string[])[]): string[] {
  if (groups.length === 1) {
    return groups[0]!.slice(0, RELATED_CHUNK_NUMBER);
  }
  const selected: string[] = [];
  const used: number[] = [];
  let remaining = 0;
  for (let index = 0; index < groups.length; index++) {
    // 第一组到最后一组的份额从 5 递减到 1, 例如三组分配 [5, 3, 1].
    const expected = roundLikePython(
      RELATED_CHUNK_NUMBER - index / (groups.length - 1) * (RELATED_CHUNK_NUMBER - 1),
    );
    const count = Math.min(expected, groups[index]!.length);
    selected.push(...groups[index]!.slice(0, count));
    used.push(count);
    remaining += expected - count;
  }
  for (let allocation = 0; allocation < remaining; allocation++) {
    const index = groups.findIndex((group, position) => used[position]! < group.length);
    if (index === -1) {
      break;
    }
    selected.push(groups[index]![used[index]!]!);
    used[index] = used[index]! + 1;
  }
  return selected;
}

/**
 * sources 的一组对应一个实体或关系, 组的先后来自图召回排名.
 * 先统计每个块被引用的次数, 再将重复块归到首次引用它的组, 最后用传入的 query 向量在候选内选块.
 * excluded 排除实体侧已经选出的块, 让关系侧不重复占用名额.
 * removeEmptyAfterDedup 只在关系侧为 true. 实体侧保留去重后变空的组, 因为组数参与选块数量计算.
 * chunkVectorsById 引用本次查询已读取的向量行. embedding 来自完整 query.
 */
function selectGroups(
  sources: Iterable<readonly string[]>,
  excluded: ReadonlySet<string>,
  removeEmptyAfterDedup: boolean,
  embedding: Float32Array,
  chunkVectorsById: ReadonlyMap<string, NarrativeChunkVectorRow>,
  signal: AbortSignal,
): string[] {
  const original = [...sources].filter(group => group.length > 0);
  const frequency = new Map<string, number>();
  const seen = new Set(excluded);
  let groups = original.map(group => {
    const unique: string[] = [];
    for (const id of group) {
      if (excluded.has(id)) {
        continue;
      }
      frequency.set(id, (frequency.get(id) ?? 0) + 1);
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(id);
      }
    }
    return unique;
  });
  if (removeEmptyAfterDedup) {
    groups = groups.filter(group => group.length > 0);
  }
  if (groups.length === 0) {
    return [];
  }
  // 同一块归到首次引用它的实体或关系, 频次相同时保留该组的来源顺序.
  for (const group of groups) {
    group.sort((left, right) => frequency.get(right)! - frequency.get(left)!);
  }
  // 此处只按来源组数分配候选; 合并后的重排输入上限由 search 统一执行.
  const count = Math.floor(RELATED_CHUNK_NUMBER * groups.length / 2);
  const ids: string[] = [];
  const vectors: Buffer[] = [];
  for (const id of groups.flat()) {
    const row = chunkVectorsById.get(id);
    if (row !== undefined) {
      ids.push(id);
      vectors.push(row.vector);
    }
  }
  // 图已经限定了来源范围, 这里只排名, 不再应用直接向量搜索的相似度门槛.
  const selected = rankVectors(ids, vectors, embedding, count, undefined, signal);
  if (selected.length > 0) {
    return selected;
  }
  // 向量排名没有选出原文块时, 按候选组的先后分配名额.
  // 靠前的组多取一些, 某组取不满时把空余名额交给其他组.
  return pickByWeight(groups);
}

/**
 * 为命中的实体和关系选来源块. search 批量读取正文前, 调用方从向量行读取周目.
 * loadedChunkVectors 只由 mix 传入, 复用本次直接块搜索读到的向量; 未传入时只查候选 ID.
 * 两侧仍分别排名: 先选实体来源块, 关系侧再排除已经选出的块.
 */
export function retrieveSourceChunks(
  entityNames: readonly string[],
  relationIds: readonly number[],
  graph: NarrativeGraphRepo,
  chunks: NarrativeChunksRepo,
  embedding: Float32Array,
  signal: AbortSignal,
  loadedChunkVectors?: readonly NarrativeChunkVectorRow[],
): {
  entityChunks: string[];
  relationChunks: string[];
  chunkVectorsById: ReadonlyMap<string, NarrativeChunkVectorRow>;
} {
  signal.throwIfAborted();
  const entities = graph.getEntityChunkIds(entityNames);
  const relations = graph.getRelationChunkIds(relationIds);

  // mix 复用全库向量. 其他模式只读来源 ID 对应的向量, Repo 在绑定参数前去重.
  const rows = loadedChunkVectors ?? chunks.findVectorsByIds(
    [...entities.values(), ...relations.values()].flat(),
  );
  const chunkVectorsById = new Map(rows.map(row => [row.chunk_id, row]));
  const entityChunks = selectGroups(
    entities.values(),
    new Set(),
    false,
    embedding,
    chunkVectorsById,
    signal,
  );
  // 关系侧排除实体侧已选块后移除空组; 实体侧保留空组, 组数会影响候选数量.
  const relationChunks = selectGroups(
    relations.values(),
    new Set(entityChunks),
    true,
    embedding,
    chunkVectorsById,
    signal,
  );
  return { entityChunks, relationChunks, chunkVectorsById };
}
