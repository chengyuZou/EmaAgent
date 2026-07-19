// 测试角色舞台快照的原子加载、可选配置和迟到请求隔离。
import { describe, expect, it } from 'vitest';
import type { CharacterCardId } from '@ema-agent/contracts';
import { StageSnapshotLoader } from '../src/stage-snapshot-loader.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('StageSnapshotLoader', () => {
  it('把模型路径和运行配置组成一个快照', async () => {
    const loader = new StageSnapshotLoader({
      getModelPath: async () => '/cards/ema/model3.json',
      getRuntimeConfig: async () => ({ emotionMap: { happy: { expression: 'smile' } } }),
    });

    await expect(loader.load('card-ema' as CharacterCardId)).resolves.toEqual({
      cardId: 'card-ema',
      modelPath: '/cards/ema/model3.json',
      runtimeConfig: { emotionMap: { happy: { expression: 'smile' } } },
    });
  });

  it('允许明确缺少运行配置的角色使用默认配置', async () => {
    const loader = new StageSnapshotLoader({
      getModelPath: async () => '/cards/plain/model3.json',
      getRuntimeConfig: async () => null,
    });

    await expect(loader.load('card-plain' as CharacterCardId)).resolves.toMatchObject({
      cardId: 'card-plain',
      runtimeConfig: null,
    });
  });

  it('切换角色后丢弃先前角色迟到的完整结果', async () => {
    const firstPath = deferred<string>();
    const loader = new StageSnapshotLoader({
      getModelPath: (cardId) => cardId === 'card-a'
        ? firstPath.promise
        : Promise.resolve('/cards/b/model3.json'),
      getRuntimeConfig: async () => null,
    });

    const staleLoad = loader.load('card-a' as CharacterCardId);
    const currentLoad = loader.load('card-b' as CharacterCardId);
    await expect(currentLoad).resolves.toMatchObject({ cardId: 'card-b' });

    firstPath.resolve('/cards/a/model3.json');
    await expect(staleLoad).resolves.toBeNull();
  });

  it('卸载后连迟到的失败也不会重新污染舞台', async () => {
    const path = deferred<string>();
    const loader = new StageSnapshotLoader({
      getModelPath: () => path.promise,
      getRuntimeConfig: async () => null,
    });

    const load = loader.load('card-a' as CharacterCardId);
    loader.invalidate();
    path.resolve('/cards/a/model3.json');

    await expect(load).resolves.toBeNull();
  });
});
