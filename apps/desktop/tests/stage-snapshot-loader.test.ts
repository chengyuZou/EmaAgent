// 测试角色舞台候选快照的原子加载和迟到请求隔离。
import { describe, expect, it } from 'vitest';
import type { CharacterCardId } from '@ema-agent/ids';
import type { CharacterStageSnapshot } from '@ema-agent/desktop-ui';
import { CharacterStageSnapshotLoader } from '../src/characterStageSnapshotLoader.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('CharacterStageSnapshotLoader', () => {
  it('原子提交后端已经冻结顺序的完整候选快照', async () => {
    const loader = new CharacterStageSnapshotLoader({
      getPresentation: async (cardId) => snapshot(cardId, '/cards/ema/model3.json'),
    });

    await expect(loader.load('card-plain' as CharacterCardId)).resolves.toMatchObject({
      characterId: 'card-plain',
      candidates: [
        {
          kind: 'live2d',
          runtimeConfig: null,
        },
      ],
    });
  });

  it('切换角色后丢弃先前角色迟到的完整结果', async () => {
    const firstSnapshot = deferred<CharacterStageSnapshot>();
    const loader = new CharacterStageSnapshotLoader({
      getPresentation: (cardId) => cardId === 'card-a'
        ? firstSnapshot.promise
        : Promise.resolve(snapshot(cardId, '/cards/b/model3.json')),
    });

    const staleLoad = loader.load('card-a' as CharacterCardId);
    const currentLoad = loader.load('card-b' as CharacterCardId);
    await expect(currentLoad).resolves.toMatchObject({ characterId: 'card-b' });

    firstSnapshot.resolve(snapshot(
      'card-a' as CharacterCardId,
      '/cards/a/model3.json',
    ));
    await expect(staleLoad).resolves.toBeNull();
  });

  it('卸载后连迟到的失败也不会重新污染舞台', async () => {
    const presentation = deferred<CharacterStageSnapshot>();
    const loader = new CharacterStageSnapshotLoader({
      getPresentation: () => presentation.promise,
    });

    const load = loader.load('card-a' as CharacterCardId);
    loader.invalidate();
    presentation.resolve(snapshot(
      'card-a' as CharacterCardId,
      '/cards/a/model3.json',
    ));

    await expect(load).resolves.toBeNull();
  });
});

function snapshot(
  characterId: CharacterCardId,
  sourcePath: string,
): CharacterStageSnapshot {
  return {
    characterId,
    revision: '1',
    issues: [],
    candidates: [
      {
        kind: 'live2d',
        resourceId: 'live2d-main',
        label: 'Main',
        resourceRevision: '1',
        sourcePath,
        runtimeConfig: null,
      },
    ],
  };
}
