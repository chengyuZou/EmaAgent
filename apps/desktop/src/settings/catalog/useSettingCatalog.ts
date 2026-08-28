// 读取后端设置目录与当前生效值，并把单项保存和恢复默认收口在同一处。
import { useCallback, useEffect, useState } from 'react';
import {
  settingsApi,
  type SettingValueEntry,
  type SettingsCatalogItem,
} from '../../api/settings.js';

export function useSettingCatalog() {
  const [items, setItems] = useState<readonly SettingsCatalogItem[]>([]);
  const [values, setValues] = useState<ReadonlyMap<string, SettingValueEntry['value']>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [catalog, current] = await Promise.all([
        settingsApi.getCatalog(),
        settingsApi.listValues(),
      ]);
      setItems(catalog.items);
      setValues(new Map(current.items.map((entry) => [entry.key, entry.value])));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '读取设置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (key: string, value: unknown): Promise<void> => {
    const saved = await settingsApi.putValue(key, value);
    setValues((current) => new Map(current).set(key, saved.value));
  }, []);

  const reset = useCallback(async (item: SettingsCatalogItem): Promise<void> => {
    await settingsApi.deleteValue(item.key);
    setValues((current) => new Map(current).set(item.key, item.defaultValue));
  }, []);

  return { items, values, loading, error, reload: load, save, reset };
}
