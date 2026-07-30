// 测试设置自动保存器:防抖合并、tail 链串行、失败回调与 dispose 后静默。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getValueMock = vi.fn();
const putValueMock = vi.fn();

vi.mock('../src/api/settings.js', () => ({
  settingsApi: {
    getValue: (...args: unknown[]) => getValueMock(...args),
    putValue: (...args: unknown[]) => putValueMock(...args),
  },
}));

import { SettingAutosaver, type SettingSaveState } from '../src/settings/useObjectSetting.js';

interface Value { a: number; b: number }

function createSaver() {
  const committed: Value[] = [];
  const states: SettingSaveState[] = [];
  const errors: unknown[] = [];
  const saver = new SettingAutosaver<Value>('test.key', {
    onCommitted: (value) => committed.push(value),
    onSaveState: (state) => states.push(state),
    onLoadError: () => errors.push('load'),
    onSaveError: (error) => errors.push(error),
  });
  return { saver, committed, states, errors };
}

beforeEach(() => {
  vi.useFakeTimers();
  getValueMock.mockReset();
  putValueMock.mockReset();
  getValueMock.mockResolvedValue({ key: 'test.key', apply: 'nextTurn', value: { a: 1, b: 2 } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SettingAutosaver', () => {
  it('load 成功后回调权威值', async () => {
    const { saver, committed } = createSaver();
    await saver.load();
    expect(committed).toEqual([{ a: 1, b: 2 }]);
  });

  it('连续改动防抖合并为一次提交', async () => {
    putValueMock.mockResolvedValue({ key: 'test.key', apply: 'nextTurn', value: { a: 5, b: 9 } });
    const { saver, committed, states } = createSaver();
    saver.schedule({ a: 3, b: 2 });
    saver.schedule({ a: 5, b: 2 });
    saver.schedule({ a: 5, b: 9 });
    await vi.advanceTimersByTimeAsync(800);
    await vi.waitFor(() => expect(states).toContain('saved'));

    expect(putValueMock).toHaveBeenCalledTimes(1);
    expect(putValueMock).toHaveBeenCalledWith('test.key', { a: 5, b: 9 });
    expect(committed).toEqual([{ a: 5, b: 9 }]);
  });

  it('提交期间的新补丁按 tail 链续传,不乱序', async () => {
    let resolveFirst: ((v: unknown) => void) | null = null;
    putValueMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ key: 'test.key', apply: 'nextTurn', value: { a: 7, b: 2 } });
    const { saver, states } = createSaver();

    saver.schedule({ a: 3, b: 2 });
    await vi.advanceTimersByTimeAsync(800);
    expect(putValueMock).toHaveBeenCalledTimes(1);

    saver.schedule({ a: 7, b: 2 });
    await vi.advanceTimersByTimeAsync(800);
    expect(putValueMock).toHaveBeenCalledTimes(1); // 在途期间不并发

    resolveFirst?.({ key: 'test.key', apply: 'nextTurn', value: { a: 3, b: 2 } });
    await vi.waitFor(() => expect(putValueMock).toHaveBeenCalledTimes(2));
    expect(putValueMock).toHaveBeenLastCalledWith('test.key', { a: 7, b: 2 });
    expect(states[0]).toBe('saving');
  });

  it('保存失败回调错误并丢弃 pending', async () => {
    putValueMock.mockRejectedValue(new Error('decode failed'));
    const { saver, states, errors } = createSaver();
    saver.schedule({ a: 99, b: 2 });
    await vi.advanceTimersByTimeAsync(800);
    await vi.waitFor(() => expect(states).toContain('error'));

    expect(errors).toHaveLength(1);
    // pending 已丢弃:再调度新值应正常提交。
    putValueMock.mockResolvedValue({ key: 'test.key', apply: 'nextTurn', value: { a: 4, b: 2 } });
    saver.schedule({ a: 4, b: 2 });
    await vi.advanceTimersByTimeAsync(800);
    await vi.waitFor(() => expect(putValueMock).toHaveBeenCalledTimes(2));
  });

  it('dispose 后不再触发回调', async () => {
    putValueMock.mockResolvedValue({ key: 'test.key', apply: 'nextTurn', value: { a: 1, b: 2 } });
    const { saver, committed } = createSaver();
    saver.dispose();
    saver.schedule({ a: 1, b: 2 });
    await vi.advanceTimersByTimeAsync(800);
    expect(putValueMock).not.toHaveBeenCalled();
    expect(committed).toEqual([]);
  });
});
