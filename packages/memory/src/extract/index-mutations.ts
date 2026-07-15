import type { VectorIndex } from '../vector-index/vector-index.js';

export interface PendingIndexMutation {
  index:     VectorIndex;
  operation: 'add' | 'update';
  id:        string;
  vector:    Float32Array;
}

/**
 * 向量索引是 SQLite 的派生缓存，必须等数据库事务提交成功后再更新。
 * 单次缓存更新失败不会反向宣告数据库提交失败；下次索引重建会恢复一致性。
 */
export function applyIndexMutations(mutations: readonly PendingIndexMutation[]): void {
  for (const mutation of mutations) {
    try {
      mutation.index[mutation.operation](mutation.id, mutation.vector);
    } catch (error) {
      console.warn(
        `[memory] vector index ${mutation.operation} failed for ${mutation.id}; rebuild required:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}
