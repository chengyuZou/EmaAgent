import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Tooltip, Button, Callout, Input, Select } from '@ema-agent/ui';
import { sessionsApi, type ArchivedSession } from '../../api/sessions.js';
import { subscribeSystemEvent } from '../../lib/system-event-dispatcher.js';
import { runWithToast } from '../../lib/toast.js';
import { formatSessionTitle, useSessionStore } from '../../stores/session.js';

const ALL_PROJECTS = 'all';
const NO_PROJECT = 'none';

function projectValue(session: ArchivedSession): string {
  return session.projectId === null ? NO_PROJECT : `project:${session.projectId}`;
}

function useArchivedSessions() {
  const [sessions, setSessions] = useState<ArchivedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await sessionsApi.listArchived();
      if (mounted.current && currentRequest === requestId.current) setSessions(result);
    } catch (failure) {
      if (mounted.current && currentRequest === requestId.current) {
        setError(failure instanceof Error ? failure.message : '加载归档聊天失败');
      }
    } finally {
      if (mounted.current && currentRequest === requestId.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = subscribeSystemEvent(event => {
      if (event.type === 'session_list_changed') void refresh();
    });
    return () => {
      mounted.current = false;
      requestId.current += 1;
      unsubscribe();
    };
  }, [refresh]);
  return { sessions, loading, error, refresh };
}

export function ArchivedChatsTab(): JSX.Element {
  const { sessions, loading, error, refresh } = useArchivedSessions();
  const [query, setQuery] = useState('');
  const [project, setProject] = useState(ALL_PROJECTS);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const projectOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const session of sessions) {
      options.set(projectValue(session), session.projectName ?? '无项目');
    }
    return [
      { value: ALL_PROJECTS, label: '所有项目' },
      ...[...options].map(([value, label]) => ({ value, label })),
    ];
  }, [sessions]);
  useEffect(() => {
    if (!projectOptions.some(option => option.value === project)) setProject(ALL_PROJECTS);
  }, [projectOptions, project]);
  const groups = useMemo(() => {
    const grouped = new Map<string, { name: string; sessions: ArchivedSession[] }>();
    const titleQuery = query.trim().toLocaleLowerCase();
    for (const session of sessions) {
      const value = projectValue(session);
      if (project !== ALL_PROJECTS && project !== value) continue;
      // 搜索完整标题, 不是显示时截短的标题, 也不匹配项目名称或 ID.
      if (!session.title.toLocaleLowerCase().includes(titleQuery)) continue;
      const group = grouped.get(value) ?? { name: session.projectName ?? '无项目', sessions: [] };
      group.sessions.push(session);
      grouped.set(value, group);
    }
    return [...grouped.entries()];
  }, [sessions, query, project]);

  async function unarchive(sessionId: string): Promise<void> {
    setRestoringId(sessionId);
    try {
      await useSessionStore.getState().unarchiveSession(sessionId);
      await refresh();
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header>
        <h2 className="text-xl font-semibold">归档聊天</h2>
        <p className="mt-2 text-sm text-[var(--ema-text-secondary)]">
          这里仅展示归档概况, 不可发送消息. 取消归档后可在聊天侧栏继续使用, 已停止的工作不会自动恢复.
        </p>
      </header>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          type="search"
          mono={false}
          aria-label="搜索归档聊天标题"
          placeholder="搜索归档聊天标题"
          value={query}
          onChange={event => setQuery(event.target.value)}
          className="min-w-0 flex-1"
        />
        <Select
          aria-label="归档聊天项目筛选"
          value={project}
          onChange={setProject}
          options={projectOptions}
          className="sm:w-48"
        />
      </div>
      {error && (
        <Callout variant="danger">
          <div className="flex items-center justify-between gap-3">
            <span>{error}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refresh()}
            >
              重试
            </Button>
          </div>
        </Callout>
      )}
      {loading && sessions.length === 0 && (
        <p className="text-sm text-[var(--ema-text-tertiary)]" role="status">正在加载归档聊天...</p>
      )}
      {!loading && !error && groups.length === 0 && (
        <p className="py-8 text-center text-sm text-[var(--ema-text-tertiary)]">
          {sessions.length === 0 ? '暂无归档聊天' : '没有匹配的归档聊天'}
        </p>
      )}
      {groups.map(([value, group]) => (
        <section
          key={value}
          className="flex flex-col gap-3"
          aria-label={group.name}
        >
          <div className="flex items-center justify-between text-sm">
            <h3 className="flex min-w-0 items-center gap-2 font-medium">
              <span className="i-lucide:folder shrink-0" aria-hidden />
              <span className="truncate">{group.name}</span>
            </h3>
            <span className="shrink-0 text-[var(--ema-text-tertiary)]">{group.sessions.length} 个聊天</span>
          </div>
          <div className="divide-y divide-[var(--ema-border)] rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-2)]">
            {group.sessions.map(session => (
              <div
                key={session.id}
                className="flex items-center gap-4 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <Tooltip content={session.title} variant="card">
                    <p className="truncate text-sm font-medium">
                      {formatSessionTitle(session.title)}
                    </p>
                  </Tooltip>
                  <p className="mt-1 text-xs text-[var(--ema-text-tertiary)]">
                    归档于 {new Date(session.archivedAt).toLocaleString()}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={restoringId !== null}
                  loading={restoringId === session.id}
                  onClick={() => void runWithToast(unarchive(session.id), '取消归档失败')}
                >
                  取消归档
                </Button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}
