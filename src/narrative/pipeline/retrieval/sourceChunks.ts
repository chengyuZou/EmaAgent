import type {
  NarrativeChunksRepo,
  NarrativeChunkVectorRow,
  NarrativeGraphRepo,
  NarrativeTimelineId,
} from '@ema-agent/storage';
import { RELATED_CHUNK_NUMBER } from '../constants.js';
import { rankVectors } from '../vectors.js';

/**
 * 模拟 Python 的 `round` 
 * 保持和LightRAG的原 Python 算法一致, 避免 `.5` 时分配数量发生偏移
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
  // 第 index 个组已经分配的块数
  const used: number[] = [];
  let remaining = 0;
  for (let index = 0; index < groups.length; index++) {
    // 第 index 个组期望分到的块数
    // 从第一组的 R 个 线性递减到最后一组的 1 个
    // 例如 5 组时, 期望分配数量为 [5, 4, 3, 2, 1]
    // 例如 3 组时, 期望分配数量为 [5, 3, 1]
    const expected = roundLikePython(
      RELATED_CHUNK_NUMBER - index / (groups.length - 1) * (RELATED_CHUNK_NUMBER - 1),
    );
    const count = Math.min(expected, groups[index]!.length);
    selected.push(...groups[index]!.slice(0, count));
    used.push(count);
    remaining += expected - count;
  }
  for (let allocation = 0; allocation < remaining; allocation++) {
    // 从前往后找第一个还有剩余块的组
    // used[position] 是该组已取数量 group.length 是该组总数量
    // used[position] < group.length 就说明这个组还有块没取
    const index = groups.findIndex((group, position) => used[position]! < group.length);
    if (index === -1) {
      break;
    }
    // groups[index][used[index]] 就是该组下一个未取块
    // used[index] 既是已取数量 也是下一个待取下标
    selected.push(groups[index]![used[index]!]!);
    used[index] = used[index]! + 1;
  }
  return selected;
}

/**
 * sources 的一组对应一个实体或关系, 组的先后来自图召回排名.
 * 先统计每个块被引用的次数, 再将重复块归到首次引用它的组, 最后用子问题向量在候选内选块.
 * excluded 排除实体侧已经选出的块, 让关系侧不重复占用名额.
 * removeEmptyAfterDedup 只在关系侧为 true. 实体侧保留去重后变空的组, 因为组数参与选块数量计算.
 * vectorsById 只引用本次查询已读取的候选向量; embedding 是子问题向量, 不是提取的关键词向量.
 */
function selectGroups(
  sources: Iterable<readonly string[]>,
  excluded: ReadonlySet<string>,
  removeEmptyAfterDedup: boolean,
  embedding: Float32Array,
  vectorsById: ReadonlyMap<string, Buffer>,
  signal: AbortSignal,
): string[] {
  // 过滤空块 统计频次并去重
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
  // 原生来源选块数量随组数增加; 最终正文另受 CHUNK_TOP_K 和字符长度限制.
  const count = Math.floor(RELATED_CHUNK_NUMBER * groups.length / 2);
  const ids: string[] = [];
  const vectors: Buffer[] = [];
  for (const id of groups.flat()) {
    const vector = vectorsById.get(id);
    if (vector !== undefined) {
      ids.push(id);
      vectors.push(vector);
    }
  }
  // 图已经限定了来源范围, 这里只排名, 不再应用直接向量搜索的相似度门槛.
  const selected = rankVectors(ids, vectors, embedding, count, undefined, signal);
  if (selected.length > 0) {
    return selected;
  }
  return pickByWeight(groups);
}

/**
 * 从保留下来的实体/关系找到来源块. 两侧候选的向量一次读取, 正文留给 queryTimeline 批量读取.
 * loadedChunkVectors 只由 mix 传入, 复用本次直接块搜索读到的向量; 未传入时只查候选 ID.
 * 两侧仍分别排名: 先选实体来源块, 关系侧再排除已经选出的块.
 */
export function retrieveSourceChunks(
  timeline: NarrativeTimelineId,
  entityNames: readonly string[],
  relationIds: readonly number[],
  graph: NarrativeGraphRepo,
  chunks: NarrativeChunksRepo,
  embedding: Float32Array,
  signal: AbortSignal,
  loadedChunkVectors?: readonly NarrativeChunkVectorRow[],
): { entityChunks: string[]; relationChunks: string[] } {
  signal.throwIfAborted();
  const entities = graph.getEntityChunkIds(timeline, entityNames);
  const relations = graph.getRelationChunkIds(timeline, relationIds);
  const candidateIds = new Set([...entities.values(), ...relations.values()].flat());
  const rows = loadedChunkVectors === undefined
    ? chunks.findVectorsByIds(timeline, [...candidateIds])
    : loadedChunkVectors.filter(row => candidateIds.has(row.chunk_id));
  // Map 只存候选 Buffer 的引用, 不复制正文或向量, 也不在查询结束后保存.
  const vectorsById = new Map(rows.map(row => [row.chunk_id, row.vector]));
  const entityChunks = selectGroups(
    entities.values(), new Set(), false, embedding, vectorsById, signal,
  );
  // 原生关系选块先排除已选实体块, 然后去掉空组; 实体选块则保留去重后的空组.
  const relationChunks = selectGroups(
    relations.values(), new Set(entityChunks), true, embedding, vectorsById, signal,
  );
  return { entityChunks, relationChunks };
}
