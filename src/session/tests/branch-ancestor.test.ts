// 测试 BranchAncestorTable: getAncestorChain 的 visited 防护——父图成环时抛错
// 而不是死循环到 OOM(B-060); 正常树形行为不受影响; LCA/KthAncestor 基本语义回归。

import { describe, expect, it } from 'vitest';
import { BranchAncestorTable } from '../branch-ancestor.js';
import { asBranchId } from '@ema-agent/contracts';

const A = asBranchId('branch-a');
const B = asBranchId('branch-b');
const C = asBranchId('branch-c');
const D = asBranchId('branch-d');

describe('BranchAncestorTable.getAncestorChain 成环防护(B-060)', () => {
  it('直接回环(A<->B)抛 branch_cycle_detected, 不死循环', () => {
    const table = new BranchAncestorTable([
      { id: A, parentBranchId: B },
      { id: B, parentBranchId: A },
    ]);
    expect(() => table.getAncestorChain(A)).toThrow(/branch_cycle_detected/);
    expect(() => table.getAncestorChain(B)).toThrow(/branch_cycle_detected/);
  });

  it('自环(A->A)同样抛错', () => {
    const table = new BranchAncestorTable([{ id: A, parentBranchId: A }]);
    expect(() => table.getAncestorChain(A)).toThrow(/branch_cycle_detected/);
  });

  it('正常树(root->A->B->C)行为不受影响, 链序为 root 在前', () => {
    const table = new BranchAncestorTable([
      { id: A, parentBranchId: null },
      { id: B, parentBranchId: A },
      { id: C, parentBranchId: B },
      { id: D, parentBranchId: A },
    ]);
    expect(table.getAncestorChain(C)).toEqual([A, B, C]);
    expect(table.getAncestorChain(D)).toEqual([A, D]);
    expect(table.getAncestorChain(A)).toEqual([A]);
  });

  it('LCA 与 getKthAncestor 基本语义回归', () => {
    const table = new BranchAncestorTable([
      { id: A, parentBranchId: null },
      { id: B, parentBranchId: A },
      { id: C, parentBranchId: B },
      { id: D, parentBranchId: B },
    ]);
    expect(table.getLCA(C, D)).toBe(B);
    expect(table.getKthAncestor(C, 1)).toBe(B);
    expect(table.getKthAncestor(C, 2)).toBe(A);
    expect(table.getKthAncestor(C, 3)).toBeNull();
  });
});
