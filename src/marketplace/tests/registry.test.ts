// 这里测试市场 Adapter 注册冲突, 有界并发, 稳定排序和请求取消.
import { describe, expect, it } from 'vitest';
import { MarketRegistry } from '../registry.js';
import type { MarketSourceAdapter, MarketSourceRecord } from '../types.js';

function source(id: string, sortOrder: number, createdAt = 1): MarketSourceRecord {
  return {
    id,
    kind: 'skill',
    type: 'test',
    label: id,
    config: '{}',
    enabled: true,
    builtin: false,
    sortOrder,
    createdAt,
  };
}

function adapter(list: MarketSourceAdapter<string>['list']): MarketSourceAdapter<string> {
  return {
    kind: 'skill',
    types: ['test'],
    list,
    validateConfig: () => ({ ok: true, config: '{}' }),
    describeTypes: () => [],
  };
}

describe('MarketRegistry', () => {
  it('重复 kind 在启动接线时直接失败', () => {
    const registry = new MarketRegistry();
    registry.registerAdapter(adapter(async () => []));
    expect(() => registry.registerAdapter(adapter(async () => []))).toThrow('重复注册');
  });

  it('按 sortOrder、createdAt、id 稳定返回，并限制并发数', async () => {
    const registry = new MarketRegistry(2);
    let active = 0;
    let peak = 0;
    registry.registerAdapter(adapter(async current => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return [current.id];
    }));

    const results = await registry.listAll<string>('skill', [
      source('c', 2),
      source('b', 1, 2),
      source('a', 1, 1),
    ]);

    expect(peak).toBe(2);
    expect(results.map(result => result.sourceId)).toEqual(['a', 'b', 'c']);
  });

  it('取消后不把中止伪装成某个源的普通错误', async () => {
    const controller = new AbortController();
    const registry = new MarketRegistry();
    registry.registerAdapter(adapter(async (_current, signal) => {
      controller.abort(new Error('用户取消'));
      await Promise.resolve();
      if (signal?.aborted) throw signal.reason;
      return [];
    }));

    await expect(registry.listAll('skill', [source('a', 1)], controller.signal))
      .rejects.toThrow('用户取消');
  });
});
