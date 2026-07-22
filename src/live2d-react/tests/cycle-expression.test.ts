// 测试表情轮换的原子语义: 旧快照轮换(先清空再读)改为 store 内部一次读取决策。
import { describe, expect, it, vi } from 'vitest';

import { createLive2DStore, type Live2DStoreApi } from '../stores/live2d-store.js';

function makeStore(expressions: string[]): Live2DStoreApi {
  const store = createLive2DStore();
  store.getState()._setExpressionsAvailable(expressions);
  return store;
}

function activeName(store: Live2DStoreApi): string | undefined {
  return store.getState().activeExpressions[0]?.name;
}

describe('live2d-store cycleExpression', () => {
  it('空候选列表无操作', () => {
    const store = makeStore([]);
    store.getState().setExpression('anything', { source: 'ui' });
    store.getState().cycleExpression();

    expect(activeName(store)).toBe('anything');
  });

  it('没有激活表情时从第一项开始', () => {
    const store = makeStore(['smile', 'blush', 'angry']);
    store.getState().cycleExpression();

    expect(activeName(store)).toBe('smile');
  });

  it('连续轮换到下一项', () => {
    const store = makeStore(['smile', 'blush', 'angry']);
    store.getState().setExpression('smile', { source: 'ui' });

    store.getState().cycleExpression();
    expect(activeName(store)).toBe('blush');
    store.getState().cycleExpression();
    expect(activeName(store)).toBe('angry');
  });

  it('末尾回到开头', () => {
    const store = makeStore(['smile', 'blush']);
    store.getState().setExpression('blush', { source: 'ui' });

    store.getState().cycleExpression();
    expect(activeName(store)).toBe('smile');
  });

  it('当前表情不在候选列表时从第一项开始', () => {
    // 情感 cue 会把表情设成 emotionMap 解析名, 不一定在候选列表里——
    // 用户"永远播第一个"症状对应的正是这条回退路径。
    const store = makeStore(['smile', 'blush']);
    store.getState().setExpression('emotion-driven', { source: 'emotion' });

    store.getState().cycleExpression();
    expect(activeName(store)).toBe('smile');
  });

  it('只有一个候选时始终选择该表情', () => {
    const store = makeStore(['smile']);

    store.getState().cycleExpression();
    expect(activeName(store)).toBe('smile');
    store.getState().cycleExpression();
    expect(activeName(store)).toBe('smile');
  });

  it('替换带 duration 的旧表情后旧 timer 不再误删新表情', () => {
    vi.useFakeTimers();
    try {
      const store = makeStore(['smile', 'blush']);
      store.getState().setExpression('smile', { source: 'ui', durationSec: 5 });

      store.getState().cycleExpression();
      expect(activeName(store)).toBe('blush');

      vi.advanceTimersByTime(10_000);
      expect(activeName(store)).toBe('blush');
    } finally {
      vi.useRealTimers();
    }
  });
});
