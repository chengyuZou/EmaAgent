// 测试鼠标追踪缓存舞台几何信息，不在每次 mousemove 强制读取布局。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMouseEyeTrackPlugin } from '../src/composables/mouse-track.js';
import type { MotionPluginContext } from '../src/composables/motion-manager.js';

describe('Mouse eye tracking', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('连续鼠标事件复用缓存的 canvas bounds', () => {
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal('window', {
      addEventListener: vi.fn((name: string, listener: EventListener) => listeners.set(name, listener)),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    });

    const getBoundingClientRect = vi.fn(() => ({
      left: 0,
      right: 200,
      top: 0,
      bottom: 100,
      width: 200,
      height: 100,
    } as DOMRect));
    const canvas = { getBoundingClientRect } as HTMLCanvasElement;
    const values = new Map<string, number>();
    const plugin = createMouseEyeTrackPlugin(() => canvas);

    listeners.get('mousemove')?.({ clientX: 150, clientY: 25 } as unknown as Event);
    listeners.get('mousemove')?.({ clientX: 160, clientY: 20 } as unknown as Event);
    plugin({
      model: {
        getParameterValueById: (id) => values.get(id) ?? 0,
        setParameterValueById: (id, value) => { values.set(id, value); },
      },
      timing: { deltaMs: 1_000 / 60, elapsedMs: 1_000 / 60 },
    } as MotionPluginContext);

    expect(getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(values.get('ParamEyeBallX')).toBeGreaterThan(0);
    expect(values.get('ParamEyeBallY')).toBeLessThan(0);
    plugin.dispose();
  });
});
