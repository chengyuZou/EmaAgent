// 测试元音识别只产生统一张嘴幅度,非元音结果不冒充嘴型。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmaLipSync } from '../src/lib/wlipsync-lipsync.js';

const mocks = vi.hoisted(() => ({
  node: {
    volume: 0,
    weights: { A: 0, E: 0, I: 0, O: 0, U: 0, S: 0 },
    disconnect: vi.fn(),
  },
  createNode: vi.fn(),
}));

vi.mock('wlipsync', () => ({
  createWLipSyncNode: mocks.createNode,
}));

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.node.volume = 0;
  mocks.node.weights = { A: 0, E: 0, I: 0, O: 0, U: 0, S: 0 };
  mocks.node.disconnect.mockClear();
  mocks.createNode.mockReset();
  mocks.createNode.mockResolvedValue(mocks.node);
});

describe('createEmaLipSync', () => {
  it('忽略非元音权重,并让元音置信度和音量共同决定开口度', async () => {
    let nowMs = 1;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const lipSync = await createEmaLipSync({} as AudioContext);

    mocks.node.volume = 1;
    mocks.node.weights.S = 1;
    expect(lipSync.getMouthOpen()).toBe(0);

    mocks.node.weights.A = 0.8;
    nowMs += 50;
    expect(lipSync.getMouthOpen()).toBeGreaterThan(0);
  });

  it('把异常大的识别值限制在统一的 0..1 范围', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(1);
    mocks.node.volume = 10;
    mocks.node.weights.O = 10;
    const lipSync = await createEmaLipSync({} as AudioContext);

    expect(lipSync.getMouthOpen()).toBe(1);
  });

  it('把真实播放源接入分析节点,释放时断开节点', async () => {
    const lipSync = await createEmaLipSync({} as AudioContext);
    const source = { connect: vi.fn() } as unknown as AudioNode;

    lipSync.connectSource(source);
    expect(source.connect).toHaveBeenCalledWith(mocks.node);

    lipSync.dispose();
    expect(mocks.node.disconnect).toHaveBeenCalledOnce();
  });
});
