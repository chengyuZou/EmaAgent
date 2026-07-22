// 测试多个 Live2D 舞台的动作、表情、语音与清理状态互不串线。
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createLive2DRuntime,
  defaultLive2DRuntime,
} from '../runtime.js';
import { useExpressionStore } from '../stores/expression-store.js';
import { useLive2DStore } from '../stores/live2d-store.js';
import { useSpeechStore } from '../stores/speech-store.js';

describe('Live2DRuntime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('为每个舞台创建独立的三类 Store', () => {
    const main = createLive2DRuntime('main-test');
    const preview = createLive2DRuntime('settings-preview');

    main.live2dStore.getState().addExpression('Smile');
    main.expressionStore.getState().registerExpressions('ema', [], [{
      name: 'ParamMouthForm',
      parameterId: 'ParamMouthForm',
      blend: 'Overwrite',
      currentValue: 0,
      defaultValue: 0,
      modelDefault: 0,
      targetValue: 1,
    }]);
    main.speechStore.getState().setSpeaking(true);
    main.speechStore.getState().setRms(0.4);

    expect(preview.live2dStore.getState().activeExpressions).toEqual([]);
    expect(preview.expressionStore.getState().expressions.size).toBe(0);
    expect(preview.speechStore.getState()).toMatchObject({
      speaking: false,
      rms: 0,
      energy: 0,
    });
  });

  it('重置预览舞台不会清除主舞台状态', () => {
    const main = createLive2DRuntime('main-test');
    const preview = createLive2DRuntime('settings-preview');

    main.live2dStore.getState().playMotion('Idle', 1);
    main.speechStore.getState().setSpeaking(true);
    preview.live2dStore.getState().addExpression('PreviewSmile');
    preview.reset();

    expect(main.live2dStore.getState().currentMotion).toMatchObject({
      group: 'Idle',
      index: 1,
    });
    expect(main.speechStore.getState().speaking).toBe(true);
    expect(preview.live2dStore.getState().activeExpressions).toEqual([]);
  });

  it('一个舞台清理定时表情时不会取消另一个舞台的到期任务', () => {
    vi.useFakeTimers();
    const main = createLive2DRuntime('main-test');
    const preview = createLive2DRuntime('settings-preview');

    main.live2dStore.getState().addExpression('MainSmile', { durationSec: 1 });
    preview.live2dStore.getState().addExpression('PreviewSmile', { durationSec: 1 });
    main.reset();
    vi.advanceTimersByTime(1_000);

    expect(preview.live2dStore.getState().activeExpressions).toEqual([]);
  });

  it('兼容 Store 导出仍指向默认主舞台 Runtime', () => {
    expect(defaultLive2DRuntime.live2dStore).toBe(useLive2DStore);
    expect(defaultLive2DRuntime.expressionStore).toBe(useExpressionStore);
    expect(defaultLive2DRuntime.speechStore).toBe(useSpeechStore);
  });
});
