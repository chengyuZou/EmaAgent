import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionsApi, type SessionSummary } from '../../api/sessions.js';
import { storageStatsApi } from '../../api/storageStats.js';
import { ServerApiError } from '../../api/client.js';
import { subscribeSystemEvent } from '../../lib/events/systemEventDispatcher.js';

function sameSummary(left: SessionSummary, right: SessionSummary): boolean {
  return left.title === right.title
    && left.lastActivityAt === right.lastActivityAt
    && left.messageCount === right.messageCount
    && left.totalInputTokens === right.totalInputTokens
    && left.totalOutputTokens === right.totalOutputTokens;
}

export function useSessionDirectory() {
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useRef(() => {});
  const refresh = useCallback(() => reload.current(), []);

  useEffect(() => {
    let disposed = false;
    let readingAll = false;
    let fullPending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fullRequest: AbortController | undefined;
    const requests = new Map<string, AbortController>();
    const pending = new Set<string>();
    const deletedDuringRead = new Set<string>();
    let directory = new Map<string, SessionSummary>();
    const publish = (): void => {
      setSessions([...directory.values()].sort((left, right) => {
        const timeOrder = right.lastActivityAt - left.lastActivityAt;
        if (timeOrder !== 0 || left.id === right.id) {
          return timeOrder;
        }
        return left.id < right.id ? 1 : -1;
      }));
    };
    const readSession = async (sessionId: string): Promise<void> => {
      requests.get(sessionId)?.abort();
      const controller = new AbortController();
      requests.set(sessionId, controller);
      try {
        const session = await sessionsApi.get(sessionId, controller.signal);
        const old = directory.get(sessionId);
        // 已有会话的计数由自己的行更新. 导入或新建的会话才需要读取初始计数.
        const counts = old ?? await storageStatsApi.getSessionStats(sessionId, controller.signal);
        if (disposed || controller.signal.aborted) {
          return;
        }
        const summary: SessionSummary = {
          id: session.id,
          title: session.title,
          lastActivityAt: session.lastActivityAt,
          messageCount: counts.messageCount,
          totalInputTokens: counts.totalInputTokens,
          totalOutputTokens: counts.totalOutputTokens,
        };
        directory.set(sessionId, old && sameSummary(old, summary) ? old : summary);
        setError(null);
        publish();
      } catch (cause) {
        if (disposed || controller.signal.aborted) {
          return;
        }
        if (cause instanceof ServerApiError && cause.status === 404) {
          directory.delete(sessionId);
          publish();
        } else {
          setError(cause instanceof Error ? cause.message : '会话目录读取失败');
        }
      } finally {
        if (requests.get(sessionId) === controller) {
          requests.delete(sessionId);
        }
      }
    };
    const flush = (): void => {
      if (disposed || readingAll) {
        return;
      }
      if (fullPending) {
        fullPending = false;
        void readAll();
        return;
      }
      for (const sessionId of pending) {
        void readSession(sessionId);
      }
      pending.clear();
    };
    const readAll = async (): Promise<void> => {
      if (readingAll) {
        fullPending = true;
        return;
      }
      readingAll = true;
      deletedDuringRead.clear();
      for (const [sessionId, controller] of requests) {
        controller.abort();
        pending.add(sessionId);
      }
      fullRequest = new AbortController();
      try {
        const result = await sessionsApi.listSummaries(fullRequest.signal);
        if (disposed) {
          return;
        }
        // 删除通知可能比旧目录请求的响应先到, 不能把已删除会话重新放回列表.
        directory = new Map(result.sessions.filter(summary => !deletedDuringRead.has(summary.id)).map(summary => {
          const old = directory.get(summary.id);
          return [summary.id, old && sameSummary(old, summary) ? old : summary];
        }));
        publish();
        setError(null);
      } catch (cause) {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : '会话目录读取失败');
        }
      } finally {
        readingAll = false;
        deletedDuringRead.clear();
        if (!disposed) {
          setLoading(false);
          flush();
        }
      }
    };
    reload.current = () => { void readAll(); };
    const unsubscribe = subscribeSystemEvent(event => {
      if (event.type === 'sessions_deleted') {
        for (const sessionId of event.sessionIds) {
          requests.get(sessionId)?.abort();
          requests.delete(sessionId);
          pending.delete(sessionId);
          directory.delete(sessionId);
          if (readingAll) {
            deletedDuringRead.add(sessionId);
          }
        }
        publish();
        return;
      }
      if (event.type === 'session_list_changed' && event.sessionId === undefined) {
        fullPending = true;
      } else if (
        event.type === 'session_list_changed'
        || event.type === 'session_messages_changed'
        || event.type === 'turn_started'
        || event.type === 'turn_completed'
        || event.type === 'turn_failed'
        || event.type === 'turn_aborted'
      ) {
        if (event.sessionId !== undefined) {
          pending.add(event.sessionId);
        }
      } else {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(flush, 100);
    });
    void readAll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      fullRequest?.abort();
      for (const controller of requests.values()) {
        controller.abort();
      }
    };
  }, []);
  return { sessions, loading, error, refresh };
}
