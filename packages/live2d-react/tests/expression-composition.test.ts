// 测试多个表情共享参数时按来源和 Blend 合成，停用单组不会清除其他组。
import { describe, expect, it } from 'vitest';
import { createExpressionController } from '../src/composables/expression-controller.js';
import { createExpressionStore } from '../src/stores/expression-store.js';

function expression(parameters: Array<{
  Id: string;
  Value: number;
  Blend: 'Add' | 'Multiply' | 'Overwrite';
}>): string {
  return JSON.stringify({ Type: 'Live2D Expression', Parameters: parameters });
}

function createFixture(
  files: Record<string, string>,
  defaultValue = 0,
) {
  const values = new Map<string, number>([['ParamShared', defaultValue]]);
  const model = {
    getParameterValueById: (id: string) => values.get(id) ?? 0,
    getParameterDefaultValueById: (id: string) => values.get(id) ?? 0,
    setParameterValueById: (id: string, value: number) => { values.set(id, value); },
  };
  const store = createExpressionStore();
  const controller = createExpressionController({
    getCoreModel: () => model,
    expressionStore: store,
    modelId: 'composition-test',
  });
  const initialise = () => controller.initialise(
    Object.keys(files).map((name) => ({ Name: name, File: `${name}.exp3.json` })),
    async (path) => files[path.split('/').pop()!.replace('.exp3.json', '')]!,
    '/models/test',
  );
  const renderFrame = () => {
    controller.prepareFrame(model);
    controller.applyExpressions(model);
    return values.get('ParamShared')!;
  };
  return { controller, initialise, model, renderFrame, store, values };
}

describe('Expression contribution 合成', () => {
  it('停用共享参数的一组后，另一组 Add 贡献继续存在', async () => {
    const fixture = createFixture({
      smile: expression([{ Id: 'ParamShared', Value: 0.4, Blend: 'Add' }]),
      blush: expression([{ Id: 'ParamShared', Value: 0.2, Blend: 'Add' }]),
    });
    await fixture.initialise();

    fixture.store.getState().activate('smile');
    fixture.store.getState().activate('blush');
    expect(fixture.renderFrame()).toBeCloseTo(0.6);

    fixture.store.getState().deactivate('blush');
    expect(fixture.renderFrame()).toBeCloseTo(0.4);
    expect(fixture.store.getState().get('smile').state).toEqual([
      expect.objectContaining({ active: true }),
    ]);
  });

  it('同一参数保留每个 exp3 自己的 Overwrite/Multiply/Add', async () => {
    const fixture = createFixture({
      base: expression([{ Id: 'ParamShared', Value: 0.5, Blend: 'Overwrite' }]),
      soften: expression([{ Id: 'ParamShared', Value: 0.5, Blend: 'Multiply' }]),
      lift: expression([{ Id: 'ParamShared', Value: 0.1, Blend: 'Add' }]),
    }, 1);
    await fixture.initialise();

    fixture.store.getState().activate('base');
    fixture.store.getState().activate('soften');
    fixture.store.getState().activate('lift');
    expect(fixture.renderFrame()).toBeCloseTo(0.35);

    fixture.store.getState().deactivate('soften');
    expect(fixture.renderFrame()).toBeCloseTo(0.6);
  });

  it('同优先级 Overwrite 按激活顺序决定，重新激活会成为最新贡献', async () => {
    const fixture = createFixture({
      red: expression([{ Id: 'ParamShared', Value: 0.2, Blend: 'Overwrite' }]),
      blue: expression([{ Id: 'ParamShared', Value: 0.8, Blend: 'Overwrite' }]),
    });
    await fixture.initialise();

    fixture.store.getState().activate('red');
    fixture.store.getState().activate('blue');
    expect(fixture.renderFrame()).toBeCloseTo(0.8);

    fixture.store.getState().activate('red');
    expect(fixture.renderFrame()).toBeCloseTo(0.2);
  });

  it('高优先级贡献不会被后来激活的低优先级 Overwrite 覆盖', async () => {
    const fixture = createFixture({
      system: expression([{ Id: 'ParamShared', Value: 0.9, Blend: 'Overwrite' }]),
      preview: expression([{ Id: 'ParamShared', Value: 0.1, Blend: 'Overwrite' }]),
    });
    await fixture.initialise();

    fixture.store.getState().activate('system', true, 100);
    fixture.store.getState().activate('preview', true, 0);

    expect(fixture.renderFrame()).toBeCloseTo(0.9);
  });

  it('prepareFrame 先清上一帧写入，Add 不会逐帧累积', async () => {
    const fixture = createFixture({
      smile: expression([{ Id: 'ParamShared', Value: 0.25, Blend: 'Add' }]),
    });
    await fixture.initialise();
    fixture.store.getState().activate('smile');

    expect(fixture.renderFrame()).toBeCloseTo(0.25);
    expect(fixture.renderFrame()).toBeCloseTo(0.25);
    expect(fixture.renderFrame()).toBeCloseTo(0.25);
  });
});
