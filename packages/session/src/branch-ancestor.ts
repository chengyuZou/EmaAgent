import type { BranchId } from '@ema-agent/contracts';

interface BranchNode {
  id:              BranchId;
  parentBranchId:  BranchId | null;
}

/**
 * Sparse-table (binary lifting) index over a session's branch tree.
 *
 * Build once after loading all branches for a session; rebuild when a new
 * branch is created. For typical sessions (≤ 30 branches, depth ≤ 10) the
 * build is microseconds and the index lives in memory only.
 *
 * Provides:
 *   getAncestorChain(id) — O(depth), needed for message reconstruction
 *   getKthAncestor(id, k) — O(log k), useful for branch navigation
 *   getLCA(x, y)          — O(log n), useful for common-history comparisons
 */
export class BranchAncestorTable {
  /** pa.get(id)[i] = the 2^i-th ancestor of `id`, or null if none. */
  private readonly pa:    Map<BranchId, (BranchId | null)[]>;
  private readonly depth: Map<BranchId, number>;
  private readonly m:     number;

  constructor(branches: BranchNode[]) {
    const n  = branches.length;
    this.m   = Math.max(1, Math.ceil(Math.log2(n + 1)));
    this.pa  = new Map();
    this.depth = new Map();

    // Pass 1: initialise direct parent (2^0 ancestor).
    for (const b of branches) {
      const row = new Array<BranchId | null>(this.m).fill(null);
      row[0]    = b.parentBranchId;
      this.pa.set(b.id, row);
    }

    // Pass 2: fill higher powers — pa[i+1] = pa[pa[i]][i].
    for (let i = 0; i < this.m - 1; i++) {
      for (const b of branches) {
        // Use != null to narrow away both null and undefined (noUncheckedIndexedAccess-safe).
        const anc = this.pa.get(b.id)![i];
        this.pa.get(b.id)![i + 1] =
          anc != null ? (this.pa.get(anc)?.[i] ?? null) : null;
      }
    }

    // Pass 3: BFS depths from root (parentBranchId === null).
    const childrenOf = new Map<BranchId | null, BranchId[]>();
    for (const b of branches) {
      const p = b.parentBranchId;
      const list = childrenOf.get(p) ?? [];
      list.push(b.id);
      childrenOf.set(p, list);
    }
    const queue: BranchId[] = childrenOf.get(null) ?? [];
    for (const r of queue) this.depth.set(r, 0);
    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++]!;
      for (const child of childrenOf.get(cur) ?? []) {
        this.depth.set(child, (this.depth.get(cur) ?? 0) + 1);
        queue.push(child);
      }
    }
  }

  /**
   * Return the k-th ancestor of `branchId` (1 = direct parent).
   * Returns null when k exceeds the branch depth.  O(log k).
   */
  getKthAncestor(branchId: BranchId, k: number): BranchId | null {
    let node: BranchId | null = branchId;
    for (let i = 0; i < this.m && node !== null; i++) {
      if ((k >> i) & 1) {
        node = this.pa.get(node)?.[i] ?? null;
      }
    }
    return node;
  }

  /**
   * Lowest common ancestor of two branches.  O(log n).
   * Returns null only when both roots differ (disconnected tree — shouldn't
   * happen within a single session).
   */
  getLCA(x: BranchId, y: BranchId): BranchId | null {
    let dx = this.depth.get(x) ?? 0;
    let dy = this.depth.get(y) ?? 0;

    // Bring both to the same depth.
    if (dx < dy) { [x, y] = [y, x]; [dx, dy] = [dy, dx]; }
    const lifted = this.getKthAncestor(x, dx - dy);
    if (lifted === null) return null;
    x = lifted;

    if (x === y) return x;

    // Jump together until one step below the LCA.
    for (let i = this.m - 1; i >= 0; i--) {
      const px = this.pa.get(x)?.[i] ?? null;
      const py = this.pa.get(y)?.[i] ?? null;
      if (px !== py) {
        x = px ?? x;
        y = py ?? y;
      }
    }
    return this.pa.get(x)?.[0] ?? null;
  }

  /**
   * Full ancestor chain from root to `branchId`, inclusive.
   * Order: [root, …, parent, branchId].  O(depth).
   *
   * Used by SessionStore.loadBranchMessages() to collect branch segments
   * in the correct order for message reconstruction.
   */
  getAncestorChain(branchId: BranchId): BranchId[] {
    const chain: BranchId[] = [];
    let cur: BranchId | null = branchId;
    while (cur !== null) {
      chain.unshift(cur);
      cur = this.pa.get(cur)?.[0] ?? null;
    }
    return chain;
  }

  depthOf(branchId: BranchId): number {
    return this.depth.get(branchId) ?? 0;
  }
}
