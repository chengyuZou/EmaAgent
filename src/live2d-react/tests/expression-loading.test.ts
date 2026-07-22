// 测试 exp3 有界并发、结构校验以及只发布成功加载的表情名称。
import { describe, expect, it, vi } from 'vitest';
import { createExpressionController } from '../composables/expression-controller.js';
import { createExpressionStore } from '../stores/expression-store.js';

function createController() {
  const store = createExpressionStore();
  const controller = createExpressionController({
    getCoreModel: () => ({
      getParameterValueById: () => 0,
      getParameterDefaultValueById: () => 0,
      setParameterValueById: () => {},
    }),
    expressionStore: store,
    modelId: 'loading-test',
  });
  return { controller, store };
}

describe('Expression loading', () => {
  it('损坏资源不会进入成功清单或 expression store', async () => {
    const { controller, store } = createController();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const names = await controller.initialise([
      { Name: 'good', File: 'good.exp3.json' },
      { Name: 'bad', File: 'bad.exp3.json' },
    ], async (path) => path.includes('good')
      ? JSON.stringify({
        Type: 'Live2D Expression',
        Parameters: [{ Id: 'ParamSmile', Value: 1, Blend: 'Add' }],
      })
      : JSON.stringify({ Parameters: [{ Id: '', Value: Number.NaN, Blend: 'Mystery' }] }),
    );

    expect(names).toEqual(['good']);
    expect(Array.from(store.getState().expressionGroups.keys())).toEqual(['good']);
    warn.mockRestore();
  });

  it('最多同时读取四个表情并保持 model3 中的原始顺序', async () => {
    const { controller } = createController();
    let active = 0;
    let maximumActive = 0;
    const refs = Array.from({ length: 9 }, (_, index) => ({
      Name: `expression-${index}`,
      File: `expression-${index}.exp3.json`,
    }));

    const names = await controller.initialise(refs, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return JSON.stringify({ Type: 'Live2D Expression', Parameters: [] });
    });

    expect(maximumActive).toBe(4);
    expect(names).toEqual(refs.map((ref) => ref.Name));
  });
});
