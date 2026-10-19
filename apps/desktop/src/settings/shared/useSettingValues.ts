import { useCallback, useEffect, useState } from 'react';
import type { SettingDefinition } from '@ema-agent/server/settings';
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

  const save = useCallback(async <T,>(definition: SettingDefinition<T>, value: NoInfer<T>): Promise<void> => {
    const result = await settingsApi.putValue(definition, value);
    setValues(current => new Map(current).set(definition.key, result.value));
    setApplies(current => new Map(current).set(definition.key, result.apply));
  }, []);

  const reset = useCallback(async (definition: SettingDefinition<unknown>): Promise<void> => {
    await settingsApi.deleteValue(definition);
    const result = await settingsApi.getValue(definition);
    setValues(current => new Map(current).set(definition.key, result.value));
    setApplies(current => new Map(current).set(definition.key, result.apply));
  }, []);

  const apply = useCallback((definition: SettingDefinition<unknown>): SettingApply => {
    const value = applies.get(definition.key);
    if (!value) throw new Error(`参数 ${definition.key} 没有返回生效时机`);
    return value;
  }, [applies]);

  // The list endpoint carries mixed values. Narrow each requested value with its business schema.
  const get = useCallback(<T,>(definition: SettingDefinition<T>): T => {
    return definition.schema.parse(values.get(definition.key));
  }, [values]);

  return { get, apply, loading, error, reload: load, save, reset };
}
