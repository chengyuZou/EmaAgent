// 读取显式参数页面需要的后端值, 并收口保存和恢复默认动作.

import { useCallback, useEffect, useState } from 'react';
import { settingsApi, type SettingApply } from '../../api/settings.js';

export function useSettingValues() {
  const [values, setValues] = useState<ReadonlyMap<string, unknown>>(new Map());
  const [applies, setApplies] = useState<ReadonlyMap<string, SettingApply>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await settingsApi.listValues();
      setValues(new Map(result.items.map(entry => [entry.key, entry.value])));
      setApplies(new Map(result.items.map(entry => [entry.key, entry.apply])));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '读取参数失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (key: string, value: unknown): Promise<void> => {
    const result = await settingsApi.putValue(key, value);
    setValues(current => new Map(current).set(key, result.value));
    setApplies(current => new Map(current).set(key, result.apply));
  }, []);

  const reset = useCallback(async (key: string): Promise<void> => {
    await settingsApi.deleteValue(key);
    const result = await settingsApi.getValue(key);
    setValues(current => new Map(current).set(key, result.value));
    setApplies(current => new Map(current).set(key, result.apply));
  }, []);

  const apply = useCallback((key: string): SettingApply => {
    const value = applies.get(key);
    if (!value) throw new Error(`参数 ${key} 没有返回生效时机`);
    return value;
  }, [applies]);

  return { values, apply, loading, error, reload: load, save, reset };
}
