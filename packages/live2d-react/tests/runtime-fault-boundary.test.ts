// 测试 Live2D 动作错误限流与渲染熔断只触发一次并停止 ticker。
import { describe, expect, it, vi } from 'vitest';
import { createLive2DRuntimeFaultBoundary } from '../src/composables/runtime-fault-boundary.js';

describe('Live2D runtime fault boundary', () => {
  it('重复动作拒绝在限流窗口内只上报一次', async () => {
    const emit = vi.fn();
    const boundary = createLive2DRuntimeFaultBoundary({
      emit,
      stopRendering: vi.fn(),
      now: () => 1_000,
    });

    boundary.captureMotion(async () => { throw new Error('missing motion'); }, 'intent:Wave');
    boundary.captureMotion(async () => { throw new Error('missing motion'); }, 'intent:Wave');
    await Promise.resolve();
    await Promise.resolve();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'motion_failed',
      phase: 'motion',
      recoverable: true,
    }));
  });

  it('首个渲染错误打开熔断并停止渲染，后续错误不再上报', () => {
    const emit = vi.fn();
    const stopRendering = vi.fn();
    const boundary = createLive2DRuntimeFaultBoundary({ emit, stopRendering });

    boundary.tripRender(new Error('context lost'));
    boundary.tripRender(new Error('another frame'));

    expect(boundary.isRenderCircuitOpen()).toBe(true);
    expect(stopRendering).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'render_failed',
      phase: 'rendering',
      recoverable: false,
    }));
  });
});
