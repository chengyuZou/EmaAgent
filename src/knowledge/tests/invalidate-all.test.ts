// 测试 KbManager.invalidateAllEmbeddings 的全 KB 失效标记与单库失败隔离。
import { describe, expect, it, vi } from 'vitest';
import { KbManager } from '../manager.js';
import type { KbRecord } from '@ema-agent/storage';

function kbRecord(id: string): KbRecord {
  return {
    id,
    name: `kb-${id}`,
    path: `/tmp/${id}`,
    isActive: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

class FakeManager extends KbManager {
  constructor(
    records: KbRecord[],
    private readonly counts: Map<string, number>,
    private readonly failing: Set<string>,
  ) {
    super({
      registry: { list: () => records } as never,
      activations: {} as never,
      resolveIngestOptions: () => ({}),
    });
  }

  override async openClient(kbId: string) {
    if (this.failing.has(kbId)) throw new Error('kb.db 已损坏');
    return {
      client: { invalidateEmbeddings: vi.fn(() => this.counts.get(kbId) ?? 0) },
    } as never;
  }
}

describe('KbManager.invalidateAllEmbeddings', () => {
  it('遍历全部已注册 KB 并累计 stale 数量', async () => {
    const manager = new FakeManager(
      [kbRecord('a'), kbRecord('b')],
      new Map([['a', 3], ['b', 5]]),
      new Set(),
    );

    const result = await manager.invalidateAllEmbeddings('space-new');

    expect(result).toEqual({ kbCount: 2, markedStale: 8, failedKbIds: [] });
  });

  it('单个 KB 打开失败不中断整场，失败 id 单独返回', async () => {
    const manager = new FakeManager(
      [kbRecord('a'), kbRecord('b'), kbRecord('c')],
      new Map([['a', 2], ['c', 4]]),
      new Set(['b']),
    );

    const result = await manager.invalidateAllEmbeddings('space-new');

    expect(result).toEqual({ kbCount: 3, markedStale: 6, failedKbIds: ['b'] });
  });

  it('没有注册 KB 时返回全零', async () => {
    const manager = new FakeManager([], new Map(), new Set());

    expect(await manager.invalidateAllEmbeddings('space-new'))
      .toEqual({ kbCount: 0, markedStale: 0, failedKbIds: [] });
  });
});
