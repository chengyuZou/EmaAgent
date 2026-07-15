import { describe, expect, it } from 'vitest';
import { buildContextMessage } from '../src/recall/context-builder.js';
import { runMaintenance } from '../src/maintenance/decay.js';
import { DEFAULT_MEMORY_SETTINGS } from '../src/types.js';
import type { RecallBundle } from '../src/types.js';
import type { MemoryDeps } from '../src/deps.js';

// B-077：importance 标度必须统一 0-100。decayAmount=10 对 importance 50 衰减到 40
// （若退回 0-1 标度的 0.1，则 50-0.1=49.9，decay 形同虚设）。
describe('B-077 importance 标度统一 0-100', () => {
  it('decayAmount 默认 10（0-100 标度），非 0.1', () => {
    expect(DEFAULT_MEMORY_SETTINGS.maintenance.decayAmount).toBe(10);
  });

  it('decay 按 0-100 标度衰减：importance 50 - decayAmount 10 = 40', () => {
    const deps = {
      nodes: { listDecayCandidates: () => [{ id: 'n1', label: 'A', node_type: 'entity', importance: 50 }] },
      items: { listDecayCandidates: () => [{ id: 'i1', title: 'T', importance: 50 }] },
    } as unknown as MemoryDeps;

    const report = runMaintenance(deps, {
      nowMs: 1_000_000,
      decayAfterDays: 30,
      decayAmount: 10,
      decayItems: true,
      dryRun: true,
    });

    expect(report.preview.nodes[0].newImportance).toBe(40);
    expect(report.preview.items[0].newImportance).toBe(40);
  });
});

// B-078：context-builder 渲染边时必须用 node label，不能拼裸 UUID。
describe('B-078 context-builder 边渲染用 label 不用 UUID', () => {
  it('边的 from/to 渲染为 node label，不出现裸 id', () => {
    const msg = buildContextMessage({
      layer0: {
        nodes: [
          { id: 'uuid-a', label: '小明', nodeType: 'entity', description: '用户', importance: 50, hopDistance: 0 },
          { id: 'uuid-b', label: '小红', nodeType: 'entity', description: '朋友', importance: 50, hopDistance: 1 },
        ],
        edges: [{ from: 'uuid-a', to: 'uuid-b', relation: '朋友', weight: 1 }],
      },
      layer1: null,
      layer2: null,
    })!;

    expect(msg.content).toContain('小明');
    expect(msg.content).toContain('小红');
    expect(msg.content).not.toContain('uuid-a');
    expect(msg.content).not.toContain('uuid-b');
  });

  it('边引用未召回 node 时 fallback [unknown]，不泄露 id', () => {
    const msg = buildContextMessage({
      layer0: {
        nodes: [{ id: 'n1', label: '小明', nodeType: 'entity', description: 'x', importance: 50, hopDistance: 0 }],
        edges: [{ from: 'n1', to: 'missing-node', relation: '朋友', weight: 1 }],
      },
      layer1: null,
      layer2: null,
    })!;

    expect(msg.content).toContain('小明');
    expect(msg.content).toContain('[unknown]');
    expect(msg.content).not.toContain('missing-node');
  });
});
