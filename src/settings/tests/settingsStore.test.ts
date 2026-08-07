// 测试类型化设置的读写顺序:写必须先落库再发事件;读每次过 decode,坏值回落默认。

import { describe, expect, it, vi } from 'vitest';
import { SettingsStore, defineSetting } from '../index.js';

// 故意不声明 encode:JSON 原生形状走缺省恒等。
const countSetting = defineSetting<number>({
  key: 'test.count',
  kind: 'number',
  apply: 'immediate',
  defaultValue: 3,
  decode: value => Number.isInteger(value) && (value as number) >= 0
    ? { ok: true, value: value as number }
    : { ok: false },
});

describe('SettingsStore', () => {
  it('SQLite 写入失败时不发变更事件,随后读取仍拿到库里的旧值', () => {
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

  it('set 成功后发一次事件并携带变更键;读取返回持久化后的规范化值', () => {
    const listener = vi.fn();
    let persisted: unknown = 1;
    const store = new SettingsStore({
      read: () => ({ status: 'found', value: persisted }),
      set: (_key, value) => { persisted = value; },
      setMany: () => {},
      delete: () => {},
    });
    store.subscribe(listener);

    expect(store.set(countSetting, 9)).toBe(9);
    expect(store.get(countSetting)).toBe(9);
    expect(listener).toHaveBeenCalledWith({ revision: 1, changedKeys: ['test.count'] });
  });
});

