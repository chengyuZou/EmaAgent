import { useCallback, useEffect, useRef, useState } from 'react';
import { storageStatsApi, type DataDirStats } from '../../api/storageStats.js';
import { subscribeStorageChanges } from './storageEvents.js';

export function useStorageOverview() {
  const [stats, setStats] = useState<DataDirStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    void storageStatsApi.getStats(controller.signal).then(result => {
      if (!controller.signal.aborted) {
        setStats(result);
        setError(null);
      }
    }).catch(cause => {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : '存储统计读取失败');
      }
    });
  }, []);
  useEffect(() => {
    refresh();
    const unsubscribe = subscribeStorageChanges(undefined, refresh);
    return () => {
      unsubscribe();
      request.current?.abort();
    };
  }, [refresh]);
  return { stats, error, refresh };
}
