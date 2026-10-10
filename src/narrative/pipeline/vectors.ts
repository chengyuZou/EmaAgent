import { EMBEDDING_DIM } from './constants.js';

/**
 * 比较已读取的向量, 按相似度降序返回最多 topK 个 ID; 同分保留输入顺序.
 * ids[i] 必须对应 vectors[i]. Buffer 是资产的 1024 维小端 Float32, 不修改或复制其内容.
 * minimumScore 为 undefined 时只排名, 用于图已找到的来源块; 直接搜索由调用方传入门槛.
 * 只保留本次计算的 Top-K, 不持有 Repo、向量矩阵或跨查询缓存.
 */
export function rankVectors<K extends string | number>(
  ids: readonly K[],
  vectors: readonly Buffer[],
  query: Float32Array,
  topK: number,
  minimumScore: number | undefined,
  signal: AbortSignal,
): K[] {
  signal.throwIfAborted();
  if (topK <= 0) {
    return [];
  }
  let querySquaredNorm = 0;
  for (const value of query) {
    querySquaredNorm += value * value;
  }
  const queryNorm = Math.sqrt(querySquaredNorm);
  const selected: K[] = [];
  const scores: number[] = [];
  for (let row = 0; row < ids.length; row++) {
    const vector = vectors[row]!;
    const view = new DataView(vector.buffer, vector.byteOffset, vector.byteLength);
    let dot = 0;
    let squaredNorm = 0;
    // DataView 直接查看 Buffer 的字节, 不复制向量, 也不要求起始地址按 4 字节对齐.
    // 小端读取与资产编码一致; 点积和长度在同一遍读取中计算.
    for (let column = 0; column < EMBEDDING_DIM; column++) {
      const value = view.getFloat32(column * Float32Array.BYTES_PER_ELEMENT, true);
      dot += value * query[column]!;
      squaredNorm += value * value;
    }
    // 除以两边长度得到余弦分数, 不让向量长度抬高排名; 不重新编码或改写资产向量.
    const denominator = queryNorm * Math.sqrt(squaredNorm);
    const score = denominator === 0 ? 0 : dot / denominator;
    if (minimumScore !== undefined && score < minimumScore) {
      continue;
    }
    if (selected.length === topK && score <= scores[topK - 1]!) {
      continue;
    }
    let left = 0;
    let right = scores.length;
    // 相同分数插在已有结果后面, 与输入顺序一致; 不对全部候选创建分数对象并排序.
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (score > scores[middle]!) {
        right = middle;
      } else {
        left = middle + 1;
      }
    }
    selected.splice(left, 0, ids[row]!);
    scores.splice(left, 0, score);
    if (selected.length > topK) {
      selected.pop();
      scores.pop();
    }
  }
  signal.throwIfAborted();
  return selected;
}
