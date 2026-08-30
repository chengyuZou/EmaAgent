// 测试角色舞台候选视图的原子加载和迟到请求隔离。
import { describe, expect, it } from 'vitest';

import {
  CharacterStageLoader,
  type CharacterStageView,
} from '../src/stage/characterStageLoader.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('CharacterStageLoader', () => {
  it('原子提交后端已经冻结顺序的完整候选视图', async () => {
    const loader = new CharacterStageLoader({
      load: async (characterId) => stageView(characterId, '/models/ema.model3.json'),
    });

    await expect(loader.load('char-plain')).resolves.toMatchObject({
      characterId: 'char-plain',
      candidates: [
        {
          kind: 'live2d',
          runtimeConfig: null,
        },
      ],
    });
  });

  it('切换角色后丢弃先前角色迟到的完整结果', async () => {
    const firstView = deferred<CharacterStageView>();
    const loader = new CharacterStageLoader({
      load: (characterId) => characterId === 'char-a'
        ? firstView.promise
        : Promise.resolve(stageView(characterId, '/cards/b/model3.json')),
    });

    const staleLoad = loader.load('char-a');
    const currentLoad = loader.load('char-b');
    await expect(currentLoad).resolves.toMatchObject({ characterId: 'char-b' });

    firstView.resolve(stageView(
      'char-a',
      '/cards/a/model3.json',
    ));
    await expect(staleLoad).resolves.toBeNull();
  });

  it('卸载后连迟到的失败也不会重新污染舞台', async () => {
    const pending = deferred<CharacterStageView>();
    const loader = new CharacterStageLoader({
      load: () => pending.promise,
    });

    const load = loader.load('char-a');
    loader.invalidate();
    pending.resolve(stageView(
      'char-a',
      '/cards/a/model3.json',
    ));

    await expect(load).resolves.toBeNull();
  });
});

function stageView(
  characterId: string,
  file: string,
): CharacterStageView {
  return {
    characterId,
    candidates: [
      {
        kind: 'live2d',
        resourceId: 'live2d-main',
        name: 'Main',
        file,
        runtimeConfig: null,
        stageScale: 1,
        stageOffsetX: 0,
        stageOffsetY: 0,
        updatedAt: 1,
      },
    ],
  };
}
