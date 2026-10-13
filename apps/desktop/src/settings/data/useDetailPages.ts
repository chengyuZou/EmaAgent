import { useCallback, useEffect, useRef, useState } from 'react';

export interface DetailCursor {
  readonly createdAt: number;
  readonly id: string;
}

interface DetailPage<Row> {
  readonly items: readonly Row[];
  readonly nextCursor: DetailCursor | null;
}

/** 目录只缓存行头. 刷新读取到已加载范围的末尾, 不重置展开项或退回第一页. */
export function useDetailPages<Row extends { readonly createdAt: number }>(
  readPage: (cursor: DetailCursor | undefined, signal: AbortSignal) => Promise<DetailPage<Row>>,
  recordId: (record: Row) => string,
  order: 'asc' | 'desc' = 'desc',
) {
  const [items, setItems] = useState<readonly Row[]>([]);
  const [cursor, setCursor] = useState<DetailCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const actions = useRef({ refresh: () => {}, loadMore: () => {} });
  const refresh = useCallback(() => actions.current.refresh(), []);
  const loadMore = useCallback(() => actions.current.loadMore(), []);

  useEffect(() => {
    let disposed = false;
    let busy = false;
    let refreshPending = false;
    let morePending = false;
    let loaded: readonly Row[] = [];
    let nextCursor: DetailCursor | null = null;
    const controller = new AbortController();
    setItems([]);
    setCursor(null);
    setLoading(true);
    setLoadingMore(false);
    setFailed(false);

    const compare = (left: Row, right: Row): number => {
      const leftId = recordId(left);
      const rightId = recordId(right);
      let result = left.createdAt - right.createdAt;
      if (result === 0 && leftId !== rightId) {
        result = leftId < rightId ? -1 : 1;
      }
      return order === 'asc' ? result : -result;
    };
    const remember = (records: readonly Row[]): Row[] => {
      const previous = new Map(loaded.map(record => [recordId(record), record]));
      const unique = new Map<string, Row>();
      for (const record of records) {
        const old = previous.get(recordId(record));
        // 行头字段是标量. 未变化的行保留原对象, memo 才能跳过重复渲染.
        const unchanged = old !== undefined
          && Object.keys(old).length === Object.keys(record).length
          && (Object.keys(record) as (keyof Row)[]).every(key => old[key] === record[key]);
        unique.set(recordId(record), unchanged ? old : record);
      }
      return [...unique.values()].sort(compare);
    };

    const run = async (more: boolean): Promise<void> => {
      if (disposed) {
        return;
      }
      if (busy) {
        if (more) {
          morePending = true;
        } else {
          refreshPending = true;
        }
        return;
      }
      if (more && nextCursor === null) {
        return;
      }
      busy = true;
      setFailed(false);
      setLoadingMore(more);
      try {
        if (more) {
          const page = await readPage(nextCursor ?? undefined, controller.signal);
          if (disposed) {
            return;
          }
          loaded = remember([...loaded, ...page.items]);
          nextCursor = page.nextCursor;
        } else {
          const boundary = loaded.at(-1);
          const loadedAll = loaded.length > 0 && nextCursor === null;
          const refreshed: Row[] = [];
          let before: DetailCursor | undefined;
          for (;;) {
            const page = await readPage(before, controller.signal);
            if (disposed) {
              return;
            }
            refreshed.push(...page.items);
            const last = page.items.at(-1);
            const reachedEnd = page.nextCursor === null
              || boundary === undefined
              || (!loadedAll && last !== undefined && compare(last, boundary) >= 0);
            if (reachedEnd) {
              // 到达原阅读范围后才移除已删除的行. 刷新中仍保留旧目录与已展开正文.
              const retained = boundary && !loadedAll
                ? refreshed.filter(record => compare(record, boundary) <= 0)
                : refreshed;
              loaded = remember(retained);
              const moreAvailable = page.nextCursor !== null || retained.length < refreshed.length;
              const lastRetained = loaded.at(-1) ?? boundary;
              // 不把刷新最后一页附带的更旧行自动加入缓存, 否则每次事件都会多加载一页.
              nextCursor = moreAvailable && lastRetained
                ? { createdAt: lastRetained.createdAt, id: recordId(lastRetained) }
                : null;
              break;
            }
            const interim = new Map(loaded.map(record => [recordId(record), record]));
            for (const record of refreshed) {
              interim.set(recordId(record), record);
            }
            setItems(remember([...interim.values()]));
            before = page.nextCursor ?? undefined;
          }
        }
        setItems(loaded);
        setCursor(nextCursor);
      } catch {
        if (!disposed) {
          setFailed(true);
        }
      } finally {
        busy = false;
        if (!disposed) {
          setLoading(false);
          setLoadingMore(false);
          if (refreshPending) {
            refreshPending = false;
            void run(false);
          } else if (morePending) {
            morePending = false;
            void run(true);
          }
        }
      }
    };
    actions.current = {
      refresh: () => { void run(false); },
      loadMore: () => { void run(true); },
    };
    void run(false);
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [readPage, recordId, order]);

  return { items, cursor, loading, loadingMore, failed, refresh, loadMore };
}
