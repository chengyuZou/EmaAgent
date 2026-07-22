// 参考实现, 不在主路径 — Euler Tour + RMQ O(1) LCA。主路径使用 Binary Lifting (branch-ancestor.ts)。
// 保留此文件: 学习用途 + 未来深度 > 500 且查询 QPS 极高的高规模场景备选(2026-07-17 定)。

import type { BranchId } from '@ema-agent/ids';

interface BranchNode {
  id:              BranchId;
  parentBranchId:  BranchId | null;
}

/**
 * Euler Tour + RMQ (Sparse Table) LCA — O(1) 查询。
 *
 * 原理：
 *   1. DFS 遍历树生成 Euler Tour 序列（每进入/离开节点都记录）
 *   2. LCA(x, y) = Euler Tour 中 x 首次出现与 y 首次出现之间深度最小的节点
 *   3. 用 Sparse Table 实现 O(1) 区间最小值查询
 *
 * 构建 O(N log N)，查询 O(1)。
 *
 * 权衡：
 *   - 查询比 Binary Lifting 快 ~3-7x（实测 1M 分支：1μs vs 4μs）
 *   - 内存约为 Binary Lifting 的 2x（Euler Tour + Sparse Table）
 *   - 不支持 getKthAncestor（需额外 parent map 回退 O(k)）
 *   - 不支持 getAncestorChain（需额外 parent map 回退 O(depth)）
 *
 * 适用于：一次性构建 + 海量查询 + 内存充裕的场景。
 */
export class EulerTourRMQLCA {
  /** Euler Tour 序列：按 DFS 遍历顺序记录经过的节点 */
  private readonly euler:       BranchId[];
  /** euler[i] 对应的深度 */
  private readonly eulerDepth:  number[];
  /** 每个节点在 euler 中首次出现的下标 */
  private readonly first:       Map<BranchId, number>;
  /** Sparse Table: st[i][k] = [i, i+2^k-1] 区间内深度最小的 eulerDepth 下标 */
  private readonly st:          number[][];
  /** 预计算的 log2 表：log2[i] = floor(log2(i)) */
  private readonly log2:        number[];

  constructor(branches: BranchNode[]) {
    // ── 建邻接表 ──
    const childrenOf = new Map<BranchId | null, BranchId[]>();
    for (const b of branches) {
      const p = b.parentBranchId;
      const list = childrenOf.get(p) ?? [];
      list.push(b.id);
      childrenOf.set(p, list);
    }

    // ── 迭代 DFS 生成 Euler Tour（避免大数据递归栈溢出） ──
    // state: 0 = 进入节点, 1 = 离开节点（回到父节点）
    this.euler = [];
    this.eulerDepth = [];
    this.first = new Map();
    const nodeDepth = new Map<BranchId, number>();

    interface StackFrame {
      node:   BranchId;
      parent: BranchId | null;
      state:  0 | 1;
    }

    const roots = childrenOf.get(null) ?? [];
    const stack: StackFrame[] = [];
    for (const r of roots) {
      stack.push({ node: r, parent: null, state: 0 });
    }

    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.state === 0) {
        // ── 进入节点 ──
        const d = frame.parent !== null
          ? (nodeDepth.get(frame.parent) ?? 0) + 1
          : 0;
        nodeDepth.set(frame.node, d);
        this.euler.push(frame.node);
        this.eulerDepth.push(d);
        if (!this.first.has(frame.node)) {
          this.first.set(frame.node, this.euler.length - 1);
        }

        // 先压 exit frame，再压 children（倒序保证正序遍历）
        stack.push({ node: frame.node, parent: frame.parent, state: 1 });
        const kids = childrenOf.get(frame.node) ?? [];
        for (let i = kids.length - 1; i >= 0; i--) {
          stack.push({ node: kids[i]!, parent: frame.node, state: 0 });
        }
      } else {
        // ── 离开节点 → 回到父节点（根节点不记录回退） ──
        if (frame.parent !== null) {
          this.euler.push(frame.parent);
          this.eulerDepth.push(nodeDepth.get(frame.parent) ?? 0);
        }
      }
    }

    // ── 建 Sparse Table ──
    const len = this.eulerDepth.length;
    const LOG = Math.max(1, Math.ceil(Math.log2(len + 1)));

    this.st = Array.from({ length: len }, () => new Array<number>(LOG).fill(0));
    this.log2 = new Array<number>(len + 1).fill(0);

    for (let i = 2; i <= len; i++) {
      this.log2[i] = this.log2[i >> 1]! + 1;
    }

    // k=0：区间长度为 1，最小值就是自身
    for (let i = 0; i < len; i++) {
      this.st[i]![0] = i;
    }

    // 倍增填充 st[i][k]
    for (let k = 1; k < LOG; k++) {
      for (let i = 0; i + (1 << k) - 1 < len; i++) {
        const left  = this.st[i]![k - 1]!;
        const right = this.st[i + (1 << (k - 1))]![k - 1]!;
        this.st[i]![k] =
          this.eulerDepth[left]! < this.eulerDepth[right]! ? left : right;
      }
    }
  }

  /** RMQ(L, R) — O(1)，返回 [L, R] 内 eulerDepth 最小的下标 */
  private rmq(L: number, R: number): number {
    if (L > R) { [L, R] = [R, L]; }
    const k   = this.log2[R - L + 1]!;
    const left  = this.st[L]![k]!;
    const right = this.st[R - (1 << k) + 1]![k]!;
    return this.eulerDepth[left]! < this.eulerDepth[right]! ? left : right;
  }

  /**
   * Lowest common ancestor of two branches.  O(1).
   *
   * 返回 x 和 y 在 Euler Tour 中首次出现位置之间的深度最小节点，
   * 即为最近公共祖先。
   */
  getLCA(x: BranchId, y: BranchId): BranchId | null {
    const fx = this.first.get(x);
    const fy = this.first.get(y);
    if (fx === undefined || fy === undefined) return null;
    const pos = this.rmq(fx, fy);
    return this.euler[pos]!;
  }

  /**
   * 返回 branchId 的深度。O(1)。
   *
   * 只在 Euler Tour 首次出现位置记录深度，
   * 不需要维护独立的 depth Map。
   */
  depthOf(branchId: BranchId): number {
    const fx = this.first.get(branchId);
    if (fx === undefined) return 0;
    return this.eulerDepth[fx]!;
  }
}
