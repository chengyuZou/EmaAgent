import type { Cubism4InternalModel } from 'pixi-live2d-display/cubism4';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachLive2DLipSync } from '../lipSync.js';

const FRAME_MS = 1_000 / 60;

function setup() {
  const listeners = new Set<() => void>();
  const writes: number[] = [];
  const model = {
    coreModel: {
      setParameterValueByIndex: (_index: number, value: number) => writes.push(value),
    },
    on: (event: string, listener: () => void) => {
      if (event === 'beforeModelUpdate') listeners.add(listener);
    },
    off: (_event: string, listener: () => void) => listeners.delete(listener),
  } as unknown as Cubism4InternalModel;

  let nowMs = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  const frame = (): void => {
    nowMs += FRAME_MS;
    for (const listener of listeners) listener();
  };

  const lipSync = attachLive2DLipSync(model, [{
    index: 2,
    closedValue: -1,
    openValue: 3,
  }]);

  return { lipSync, writes, frame, listeners };
}

afterEach(() => vi.restoreAllMocks());

describe('attachLive2DLipSync', () => {
  it('说话期间映射参数范围并平滑逼近开口度', () => {
    const { lipSync, writes, frame } = setup();

    lipSync.set(true, 2); // 输入被钳制到 1
    frame();
    expect(writes[0]).toBeCloseTo(0.4); // -1 + 4 * (1 * 0.35)

    frame();
    expect(writes[1]!).toBeGreaterThan(writes[0]!);
  });

  it('停止说话后先衰减写入, hold 耗尽后停止控制嘴参数', () => {
    const { lipSync, writes, frame } = setup();

    lipSync.set(true, 1);
    for (let i = 0; i < 30; i++) frame();
    const speakingLast = writes.at(-1)!;

    lipSync.set(false, 0);
    frame();
    expect(writes.at(-1)!).toBeLessThan(speakingLast); // 衰减中

    // hold 期间继续写入闭嘴值, 不让模型动作提前重新打开嘴.
    for (let i = 0; i < 20; i++) frame();
    expect(writes.length).toBeGreaterThan(32);

    // hold 结束后不再写值, 由模型的 Motion 和 Expression 控制.
    for (let i = 0; i < 60; i++) frame();
    const countAfterHandoff = writes.length;
    for (let i = 0; i < 10; i++) frame();
    expect(writes.length).toBe(countAfterHandoff);
  });

  it('hold 期间重新说话立即恢复口型, handoff 后再次说话从 0 续起', () => {
    const { lipSync, writes, frame } = setup();

    lipSync.set(true, 1);
    for (let i = 0; i < 10; i++) frame();
    lipSync.set(false, 0);
    for (let i = 0; i < 5; i++) frame();
    const duringHold = writes.at(-1)!;

    lipSync.set(true, 1);
    frame();
    expect(writes.at(-1)!).toBeGreaterThan(duringHold);

    lipSync.set(false, 0);
    for (let i = 0; i < 60; i++) frame(); // 走完 hold 进入 handoff
    const handedOffCount = writes.length;

    lipSync.set(true, 1);
    frame();
    expect(writes.length).toBe(handedOffCount + 1); // 重新占有
  });

  it('从未说话时不写任何参数', () => {
    const { writes, frame } = setup();
    for (let i = 0; i < 10; i++) frame();
    expect(writes).toHaveLength(0);
  });

  it('dispose 移除帧监听', () => {
    const { lipSync, listeners } = setup();
    lipSync.dispose();
    expect(listeners.size).toBe(0);
  });
});
