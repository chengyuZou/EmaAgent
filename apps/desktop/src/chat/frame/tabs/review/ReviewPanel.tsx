// 审阅 Session 工具改动与工作区 Git 差异，并允许外部入口定向到具体范围。
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Button, DropdownMenu, IconButton, Input, Spinner } from '@ema-agent/ui';

import {
  sessionGitApi,
  type SessionGitRefs,
  type SessionGitWorkspaceDiff,
} from '../../../../api/git.js';
import { useDockTabs, fileTab } from '../../dockTabs.js';
import { DiffCard, type ReviewFileItem } from './DiffCard.js';
import { useLatestTurnDiffs, useSessionDiffs } from './reviewDiffs.js';
import { useReviewNavigation, type ReviewSource } from './reviewNavigation.js';

type PanelView = 'diff' | 'files';
type GitDiffFile = Extract<SessionGitWorkspaceDiff, { capability: 'ok' }>['staged']['files'][number];
type GitRefsOk = Extract<SessionGitRefs, { capability: 'ok' }>;

function sourceLabel(source: ReviewSource): string {
  switch (source.kind) {
    case 'latest': return '上一轮';
    case 'session': return '全部会话';
    case 'workspace': return '工作区变更';
    case 'staged': return '已暂存';
    case 'unstaged': return '未暂存';
    case 'branch': return `比较 ${source.branch}`;
    case 'commit': return source.subject || source.sha.slice(0, 8);
  }
}

function gitFileItem(file: GitDiffFile, scope: string): ReviewFileItem {
  return {
    key: `${scope}:${file.path}`,
    displayPath: file.path,
    absolutePath: file.absolutePath,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    unifiedDiff: file.unifiedDiff,
    truncated: file.truncated,
  };
}

export function ReviewPanel({ sessionId }: { sessionId: string | null }): JSX.Element {
  const openTab = useDockTabs((state) => state.openTab);
  const source = useReviewNavigation((state): ReviewSource =>
    sessionId ? state.sourceBySession[sessionId] ?? { kind: 'latest' } : { kind: 'latest' },
  );
  const setSource = useReviewNavigation((state) => state.setSource);
  const allDiffs = useSessionDiffs(sessionId);
  const latestDiffs = useLatestTurnDiffs(sessionId);

  const [gitItems, setGitItems] = useState<readonly ReviewFileItem[]>([]);
  const [gitRefs, setGitRefs] = useState<GitRefsOk | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [view, setView] = useState<PanelView>('diff');
  const [split, setSplit] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [filter, setFilter] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [pendingScrollKey, setPendingScrollKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let current = true;
    void sessionGitApi.refs(sessionId).then((result) => {
      if (current) setGitRefs(result.capability === 'ok' ? result : null);
    }).catch(() => {
      if (current) setGitRefs(null);
    });
    return () => { current = false; };
  }, [sessionId, refresh]);

  useEffect(() => {
    if (!sessionId || source.kind === 'latest' || source.kind === 'session') {
      setGitItems([]);
      setGitError(null);
      setGitLoading(false);
      return;
    }
    let current = true;
    setGitLoading(true);
    setGitError(null);
    const request = source.kind === 'branch'
      ? sessionGitApi.compare(sessionId, { kind: 'branch', branch: source.branch })
      : source.kind === 'commit'
        ? sessionGitApi.compare(sessionId, { kind: 'commit', sha: source.sha })
        : sessionGitApi.workspaceDiff(sessionId);

    void request.then((result) => {
      if (!current) return;
      if (result.capability !== 'ok') {
        setGitItems([]);
        setGitError(result.capability === 'not-a-repo'
          ? '当前 Session 没有 Git 工作区'
          : result.capability === 'git-unavailable'
            ? '本机没有可用的 Git'
            : 'Git 差异读取失败');
        return;
      }
      if ('diff' in result) {
        setGitItems(result.diff.files.map((file) => gitFileItem(file, source.kind)));
        return;
      }
      const staged = result.staged.files.map((file) => gitFileItem(file, 'staged'));
      const unstaged = result.unstaged.files.map((file) => gitFileItem(file, 'unstaged'));
      setGitItems(source.kind === 'staged' ? staged : source.kind === 'unstaged' ? unstaged : [...staged, ...unstaged]);
    }).catch((error: unknown) => {
      if (current) {
        setGitItems([]);
        setGitError(error instanceof Error ? error.message : 'Git 差异读取失败');
      }
    }).finally(() => {
      if (current) setGitLoading(false);
    });
    return () => { current = false; };
  }, [sessionId, source, refresh]);

  const sessionItems = useMemo<readonly ReviewFileItem[]>(() => {
    const diffs = source.kind === 'latest' ? latestDiffs : allDiffs;
    return diffs.map((diff) => ({
      key: diff.callId,
      displayPath: diff.filePath,
      absolutePath: diff.filePath,
      status: diff.status === 'created' ? 'added' : 'modified',
      additions: diff.additions,
      deletions: diff.deletions,
      unifiedDiff: diff.unifiedDiff,
      truncated: false,
    }));
  }, [source.kind, latestDiffs, allDiffs]);
  const items = source.kind === 'latest' || source.kind === 'session' ? sessionItems : gitItems;
  const visibleItems = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query ? items.filter((item) => item.displayPath.toLowerCase().includes(query)) : items;
  }, [items, filter]);
  const totals = useMemo(() => ({
    additions: items.reduce((sum, item) => sum + item.additions, 0),
    deletions: items.reduce((sum, item) => sum + item.deletions, 0),
  }), [items]);

  useEffect(() => {
    if (!items.some((item) => item.key === activeKey)) setActiveKey(items[0]?.key ?? null);
  }, [activeKey, items]);
  useEffect(() => {
    if (!pendingScrollKey) return;
    const node = listRef.current?.querySelector(`[data-review-key="${CSS.escape(pendingScrollKey)}"]`);
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setPendingScrollKey(null);
  }, [pendingScrollKey, view, visibleItems]);

  const choose = (next: ReviewSource): void => {
    if (sessionId) setSource(sessionId, next);
  };
  const menuItems = [
    { kind: 'item' as const, label: '上一轮', onSelect: () => choose({ kind: 'latest' }) },
    { kind: 'item' as const, label: '全部会话', onSelect: () => choose({ kind: 'session' }) },
    { kind: 'separator' as const },
    { kind: 'item' as const, label: '工作区变更', onSelect: () => choose({ kind: 'workspace' }) },
    { kind: 'item' as const, label: '已暂存', onSelect: () => choose({ kind: 'staged' }) },
    { kind: 'item' as const, label: '未暂存', onSelect: () => choose({ kind: 'unstaged' }) },
    ...(gitRefs?.branches.length ? [
      { kind: 'separator' as const },
      ...gitRefs.branches.filter((branch) => branch !== gitRefs.current).map((branch) => ({
        kind: 'item' as const,
        label: `比较分支 · ${branch}`,
        onSelect: () => choose({ kind: 'branch', branch }),
      })),
    ] : []),
    ...(gitRefs?.commits.length ? [
      { kind: 'separator' as const },
      ...gitRefs.commits.slice(0, 10).map((commit) => ({
        kind: 'item' as const,
        label: `${commit.sha.slice(0, 8)} · ${commit.subject}`,
        onSelect: () => choose({ kind: 'commit', sha: commit.sha, subject: commit.subject }),
      })),
    ] : []),
  ];

  const openFile = (absolutePath: string): void => {
    if (sessionId) openTab(sessionId, fileTab(absolutePath));
  };
  const jumpToFile = (key: string): void => {
    setFilter('');
    setView('diff');
    setActiveKey(key);
    setPendingScrollKey(key);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--ema-border)] px-3 py-2 text-xs">
        <DropdownMenu side="bottom" align="start" widthClass="min-w-52" items={menuItems} trigger={(
          <Button variant="ghost" size="sm" className="gap-1 px-2 py-0.5 text-[11px]">
            {sourceLabel(source)}<span className="i-lucide:chevron-down text-xs" aria-hidden />
          </Button>
        )} />
        <span className="text-[var(--ema-text-secondary)]">{items.length} 个变更</span>
        <span className="text-[var(--ema-success-text)]">+{totals.additions}</span>
        <span className="text-[var(--ema-danger-text)]">-{totals.deletions}</span>
        <span className="flex-1" />
        {source.kind !== 'latest' && source.kind !== 'session' && (
          <IconButton size="sm" label="刷新 Git 差异" icon="i-lucide:refresh-cw" onClick={() => setRefresh((value) => value + 1)} />
        )}
        <Input inputSize="sm" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="跳转到文件…" className="w-36" aria-label="按路径过滤并跳转" />
        <IconButton size="sm" label={view === 'diff' ? '文件清单视图' : '差异视图'} icon={view === 'diff' ? 'i-lucide:list' : 'i-lucide:file-diff'} toggled={view === 'files'} onClick={() => setView(view === 'diff' ? 'files' : 'diff')} />
        <IconButton size="sm" label="分列差异" icon="i-lucide:columns-2" toggled={split} onClick={() => setSplit((value) => !value)} />
        <IconButton size="sm" label="自动换行" icon="i-lucide:wrap-text" toggled={wrap} onClick={() => setWrap((value) => !value)} />
      </div>

      {gitLoading ? (
        <div className="flex flex-1 items-center justify-center"><Spinner size="md" label="正在读取 Git 差异" /></div>
      ) : gitError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-[var(--ema-danger)]">
          <span className="i-lucide:git-branch text-2xl opacity-50" aria-hidden />
          <span>{gitError}</span>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-[var(--ema-text-tertiary)]">
          <span className="i-lucide:file-diff text-2xl opacity-40" aria-hidden />
          <span>{sourceLabel(source)}没有文件变更</span>
          {source.kind === 'latest' && allDiffs.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => choose({ kind: 'session' })}>查看全部会话({allDiffs.length})</Button>
          )}
        </div>
      ) : view === 'files' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {visibleItems.map((item) => (
            <button key={item.key} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--ema-surface-2)]" onClick={() => jumpToFile(item.key)}>
              <span className="i-lucide:file-diff shrink-0 text-sm text-[var(--ema-text-tertiary)]" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--ema-text-secondary)]">{item.displayPath}</span>
              <span className="text-[11px] text-[var(--ema-success-text)]">+{item.additions}</span>
              <span className="text-[11px] text-[var(--ema-danger-text)]">-{item.deletions}</span>
            </button>
          ))}
        </div>
      ) : (
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
          <div className="flex flex-col gap-1.5">
            {visibleItems.map((item) => (
              <DiffCard key={item.key} item={item} expanded={activeKey === item.key} split={split} wrap={wrap} onToggle={() => setActiveKey((current) => current === item.key ? null : item.key)} onOpenFile={openFile} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
