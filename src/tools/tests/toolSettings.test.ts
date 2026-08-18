// tools.disabled 设置: 默认全开、存值读取、AskUser 不可禁(单一事实源)。
import { describe, expect, it } from 'vitest';
import { SettingsStore, InvalidSettingValueError } from '@ema-agent/settings';
import type { SettingsRepository } from '@ema-agent/settings';
import {
  ASK_USER_TOOL_ID,
  DEFAULT_TOOL_SETTINGS,
  disabledToolsSetting,
  readToolSettings,
} from '../settings.js';
import { BuiltinTools } from '../Tool/BuiltinToolIdentity.js';

function makeRepo(values: Record<string, unknown> = {}): SettingsRepository {
  return {
    read: (key) =>
      key in values
        ? { status: 'found' as const, value: values[key] }
        : { status: 'missing' as const },
    set: (key, value) => { values[key] = value; },
    setMany: (entries) => {
      for (const entry of entries) values[entry.key] = entry.value;
    },
    delete: (key) => { delete values[key]; },
  };
}

describe('disabledToolsSetting', () => {
  it('AskUser 身份来自框架层单一事实源', () => {
    expect(ASK_USER_TOOL_ID).toBe(BuiltinTools.AskUser.id);
    expect(ASK_USER_TOOL_ID).toBe('builtin.user.ask');
  });

  it('默认全开: 无存值回落空数组', () => {
    const store = new SettingsStore(makeRepo());
    expect(store.get(disabledToolsSetting)).toEqual([]);
    expect(DEFAULT_TOOL_SETTINGS).toEqual({ disabledToolIds: [] });
  });

  it('写入选中的内置工具 id 可读回', () => {
    const store = new SettingsStore(makeRepo());
    const ids = [BuiltinTools.WebSearch.id, BuiltinTools.Bash.id];
    store.set(disabledToolsSetting, ids);
    expect(readToolSettings(store).disabledToolIds).toEqual(ids);
  });

  it('拒绝禁用 AskUser(提问通道)', () => {
    const store = new SettingsStore(makeRepo());
    expect(() =>
      store.set(disabledToolsSetting, [BuiltinTools.AskUser.id]),
    ).toThrow(InvalidSettingValueError);
    expect(() =>
      store.set(disabledToolsSetting, [BuiltinTools.Grep.id, BuiltinTools.AskUser.id]),
    ).toThrow(InvalidSettingValueError);
  });

  it('持久坏值回落默认并返回空数组', () => {
    const store = new SettingsStore(makeRepo({
      'tools.disabled': 'not-an-array',
    }));
    expect(readToolSettings(store).disabledToolIds).toEqual([]);
  });
});
