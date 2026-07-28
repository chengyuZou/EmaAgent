// 测试类型化设置只在持久化成功后更新快照，并能从损坏值安全回退。

import { describe, expect, it, vi } from 'vitest';
import { SettingsStore, defineSetting } from '../index.js';

const countSetting = defineSetting<number>({
  key: 'test.count',
  kind: 'number',
  apply: 'immediate',
  defaultValue: 3,
  decode: value => Number.isInteger(value) && (value as number) >= 0
    ? { ok: true, value: value as number }
    : { ok: false },
  encode: value => value,
});

describe('SettingsStore', () => {
  it('SQLite 写入失败时不更新内存值，也不发送变更事件', () => {
    const listener = vi.fn();
    const store = new SettingsStore({
      read: () => ({ status: 'found', value: 4 }),
      set: () => { throw new Error('disk full'); },
      setMany: () => {},
      delete: () => {},
    });
    store.subscribe(listener);

    expect(store.get(countSetting)).toBe(4);
    expect(() => store.set(countSetting, 8)).toThrow('disk full');
    expect(store.get(countSetting)).toBe(4);
    expect(listener).not.toHaveBeenCalled();
  });

  it('持久化值损坏或类型不符时使用业务默认值', () => {
    const corrupted = new SettingsStore({
      read: () => ({ status: 'corrupted', rawValue: '{' }),
      set: () => {},
      setMany: () => {},
      delete: () => {},
    });
    const invalid = new SettingsStore({
      read: () => ({ status: 'found', value: -1 }),
      set: () => {},
      setMany: () => {},
      delete: () => {},
    });

    expect(corrupted.get(countSetting)).toBe(3);
    expect(invalid.get(countSetting)).toBe(3);
  });
});
