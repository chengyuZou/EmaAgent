// chunker 共用的选项、分块 id、孤儿合并与父子窗口归组；两个 chunker 的后处理唯一事实源。
import { estimateTextTokens } from '@ema-agent/token';
import type { DocumentBlock, DocumentChunk, DocumentBlockKind } from '../types.js';

export interface ChunkOptions {
  /** 单个分块的 token 预算上限（估算口径见 @ema-agent/token，不是模型硬限制）。 */
  maxTokens: number;
  /** 把上一块尾部这么多 token 前置到下一块，给检索保留跨块引用的上下文。 */
  overlap:   number;
  /** 孤儿合并阈值：小于它的分块尝试并入相邻块（受 maxTokens 与原子块约束）。 */
  minTokens: number;
  /** 资产 id——用作分块 id 的前缀。缺省 'doc'。 */
  assetId?:  string;
}

/** V1 冻结预算：块 256 token、overlap 48、孤儿阈值 20；父窗口 1024 由 ingest 管线单独传入。 */
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxTokens: 256,
  overlap:   48,
  minTokens: 20,
};

export interface Chunker {
  chunk(blocks: DocumentBlock[], opts: ChunkOptions): Promise<DocumentChunk[]>;
}

export function chunkId(assetId: string, index: number): string {
  return `${assetId}-c${index}`;
}

const ATOMIC_KINDS = new Set<DocumentBlockKind>(['code', 'table', 'image']);
function isAtomicChunk(c: DocumentChunk): boolean {
  return c.blockKinds.some((k) => ATOMIC_KINDS.has(k));
}

/**
 * 所有 chunker 共用的孤儿合并后处理。
 * 把过小的分块（< minTokens）向前并入前一个分块，但前提是合并结果不超过
 * maxTokens，且两边都不是原子块（code/table/image 绝不与散文粘在一起）。
 * id 会重新分配以保持序号连续。这取代了各 chunker 各自的合并逻辑，
 * 让 semantic chunker 也获得内联版本缺失的 maxTokens 守卫。
 */
export function normalizeChunkSizes(
  chunks:  DocumentChunk[],
  opts:    ChunkOptions,
  assetId: string,
): DocumentChunk[] {
  if (chunks.length === 0) return [];
  const out: DocumentChunk[] = [];
  let acc: DocumentChunk = { ...chunks[0]! };

  for (let i = 1; i < chunks.length; i++) {
    const next   = chunks[i]!;
    const merged = `${acc.text}\n\n${next.text}`;
    const canMerge =
      next.tokenCount < opts.minTokens &&          // ← 改判断小的一方
      estimateTextTokens(merged) <= opts.maxTokens &&
      !isAtomicChunk(acc) && !isAtomicChunk(next);
    if (canMerge) {
      acc = { ...acc, text: merged, tokenCount: estimateTextTokens(merged),
        blockKinds: [...new Set([...acc.blockKinds, ...next.blockKinds])] };
    } else {
      out.push(acc);
      acc = { ...next };
    }
  }
  out.push(acc);
  return out.map((c, i) => ({ ...c, id: chunkId(assetId, i) }));
}

/**
 * 父子（小到大）检索后处理。把同一 sectionPath 内、且总 token 不超父窗口
 * 预算的连续子块，归组为一个父窗口，并给每个子块盖上 parentId + parentText
 * （窗口的完整文本）。
 *
 * 不建独立的父行：父文本随子块携带，
 * FTS/嵌入仍只索引子块，而检索可以把命中的子块换成更大的父上下文。
 * 单一事实源——在 ingest 中 chunker 返回后只调用一次，
 * 让每个 chunker（recursive、semantic…）都得到一致的父分组。
 */
export function assignParents(chunks: DocumentChunk[], parentMaxTokens: number): void {
  let pIdx = 0, i = 0;
  while (i < chunks.length) {
    const assetId = chunks[i]!.assetId ?? 'doc';
    // NUL 做分隔符 标题文本不含NUL 保证不同的 sectionPath 拼出的键不碰撞
    const path    = chunks[i]!.sectionPath.join('\x00');
    const group: DocumentChunk[] = [];
    let tok = 0;
    while (i < chunks.length
           && chunks[i]!.sectionPath.join('\x00') === path
           && (group.length === 0 || tok + chunks[i]!.tokenCount <= parentMaxTokens)) {
      tok += chunks[i]!.tokenCount;
      group.push(chunks[i]!);
      i++;
    }
    if (group.length < 2) continue; // 孤儿子块替换成大上下文没有收益
    const parentId   = `${assetId}#parent${pIdx++}`;
    const parentText = group.map(c => c.text).join('\n\n');
    for (const c of group) { c.parentId = parentId; c.parentText = parentText; }
  }
}
