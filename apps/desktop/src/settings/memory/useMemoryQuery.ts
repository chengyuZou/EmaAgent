import { useCallback, useEffect, useState } from 'react';

export function useMemoryQuery<T>(
  enabled: boolean,
  intervalMs: number,
  read: (signal: AbortSignal) => Promise<T>,
): {
  readonly value: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly refresh: () => void;
} {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useCallback(() => setRefreshVersion(version => version + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    async function load(): Promise<void> {
      setLoading(true);
      try {
        const result = await read(controller.signal);
        if (!disposed) {
          setValue(result);
          setError(null);
        }
      } catch (reason) {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : '读取 Memory 数据失败');
        }
      } finally {
        if (!disposed) {
          setLoading(false);
          // 请求结束后才安排下一次, 慢查询不会同时发出多次. 0 表示只按需读取.
          if (intervalMs > 0) timer = setTimeout(() => void load(), intervalMs);
        }
      }
    }

    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, intervalMs, read, refreshVersion]);

  return { value, error, loading, refresh };
}
