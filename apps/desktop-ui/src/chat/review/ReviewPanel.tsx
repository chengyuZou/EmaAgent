// 审阅面板:上一轮/全部会话走工具 file_change presentation,未暂存/已暂存走 Git 工作区 diff;
// 支持文件清单/差异视图、统一/分列、跳转过滤、file:<path> 标签打开。没有真实来源的范围不渲染。
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Button, DropdownMenu, IconButton, Input } from '@ema-agent/ui';
import type { GitDiffFile, GitWorkspaceDiffResult } from '@ema-agent/git-utils';
import type { SessionId } from '@ema-agent/ids';
import { gitApi } from '../../api/git.js';
import { useWorkspaceStore } from '../workspace/workspaceStore.js';
import { fileTab } from '../workspace/workspaceTypes.js';
import { useLatestTurnDiffs, useSessionDiffs } from './reviewDiffs.js';
import { DiffCard, type ReviewFileItem } from './DiffCard.js';

type ReviewScope = 'latest' | 'all' | 'unstaged' | 'staged';
type PanelView = 'diff' | 'files';

const SCOPE_LABEL: Record<ReviewScope, string> = {
  latest:   '上一轮',
  all:      '全部会话',
  unstaged: '未暂存',
  staged:   '已暂存',
};

export function ReviewPanel({ sessionId }: { sessionId: string | null }): JSX.Element {
  const openTab = useWorkspaceStore((s) => s.openTab);

  const allDiffs = useSessionDiffs(sessionId);
  const latestDiffs = useLatestTurnDiffs(sessionId);

  const [scope, setScope] = useState<ReviewScope>('latest');
  const [view, setView] = useState<PanelView>('diff');
  const [split, setSplit] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [filter, setFilter] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [pendingScrollKey, setPendingScrollKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Git 工作区 diff:capability 非 ok 时未暂存/已暂存范围不渲染。
  const [workspaceDiff, setWorkspaceDiff] = useState<GitWorkspaceDiffResult | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setWorkspaceDiff(null);
      return undefined;
    }
    let cancelled = false;
    setWorkspaceLoading(true);
    gitApi.getWorkspaceDiff(sessionId)
      .then((result) => { if (!cancelled) setWorkspaceDiff(result); })
      .catch(() => { if (!cancelled) setWorkspaceDiff(null); })
      .finally(() => { if (!cancelled) setWorkspaceLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId]);

  const refreshWorkspace = (): void => {
    if (!sessionId) return;
    setWorkspaceLoading(true);
    gitApi.getWorkspaceDiff(sessionId)
      .then(setWorkspaceDiff)
      .catch(() => setWorkspaceDiff(null))
      .finally(() => setWorkspaceLoading(false));
  };

  const gitAvailable = workspaceDiff?.capability === 'ok';

  // 当前范围失去数据来源时回退上一轮,不展示空壳。
  useEffect(() => {
    if ((scope === 'unstaged' || scope === 'staged') && workspaceDiff !== null && !gitAvailable) {
      setScope('latest');
    }
  }, [scope, workspaceDiff, gitAvailable]);

  const items = useMemo<readonly ReviewFileItem[]>(() => {
    if (scope === 'unstaged' || scope === 'staged') {
      if (workspaceDiff?.capability !== 'ok') return [];
      return workspaceDiff[scope].files.map((file) => gitFileToItem(scope, file));
    }
    const diffs = scope === 'latest' ? latestDiffs : allDiffs;
    return diffs.map((diff) => ({
      key: diff.callId,
      displayPath: diff.change.filePath,
      absolutePath: diff.change.filePath,
      status: diff.change.operation === 'create' ? 'added' as const : 'modified' as const,
      additions: diff.change.additions,
      deletions: diff.change.deletions,
      unifiedDiff: diff.change.unifiedDiff,
      truncated: diff.change.truncated,
    }));
  }, [scope, workspaceDiff, latestDiffs, allDiffs]);

  const visibleItems = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) => item.displayPath.toLowerCase().includes(query));
  }, [items, filter]);

  const totals = useMemo(() => {
    if ((scope === 'unstaged' || scope === 'staged') && workspaceDiff?.capability === 'ok') {
      const scopeDiff = workspaceDiff[scope];
      return {
        additions: scopeDiff.totalAdditions,
        deletions: scopeDiff.totalDeletions,
        omitted: scopeDiff.omittedFiles,
      };
    }
    return {
      additions: items.reduce((sum, item) => sum + item.additions, 0),
      deletions: items.reduce((sum, item) => sum + item.deletions, 0),
      omitted: 0,
    };
  }, [scope, workspaceDiff, items]);

  // §5:进入时默认定位到当前 Turn 首个变更。
  useEffect(() => {
    if (!items.some((item) => item.key === activeKey)) {
      setActiveKey(items[0]?.key ?? null);
    }
  }, [activeKey, items]);

  // 文件清单点击后,渲染完成再滚动到目标 diff 块。
  useEffect(() => {
    if (!pendingScrollKey) return;
    const node = listRef.current?.querySelector(
      `[data-review-key="${CSS.escape(pendingScrollKey)}"]`,
    );
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setPendingScrollKey(null);
  }, [pendingScrollKey, view, visibleItems]);

  const openFile = (absolutePath: string): void => {
    if (sessionId) openTab(sessionId as SessionId, fileTab(absolutePath));
  };

  const jumpToFile = (key: string): void => {
    setFilter('');
    setView('diff');
    setActiveKey(key);
    setPendingScrollKey(key);
  };

  const scopeOptions: readonly ReviewScope[] = gitAvailable
    ? ['latest', 'all', 'unstaged', 'staged']
    : ['latest', 'all'];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--ema-border)] px-3 py-2 text-xs">
        {/* 比较范围:只列有真实数据来源的项(计划 §14)。 */}
        <DropdownMenu
          side="bottom"
          align="start"
          widthClass="min-w-32"
          trigger={(
            <Button variant="ghost" size="sm" className="gap-1 px-2 py-0.5 text-[11px]">
              {SCOPE_LABEL[scope]}
              <span className="i-lucide:chevron-down text-xs" aria-hidden />
            </Button>
          )}
          items={scopeOptions.map((option) => ({
            kind: 'item' as const,
            label: SCOPE_LABEL[option],
            onSelect: () => setScope(option),
          }))}
        />
        <span className="text-[var(--ema-text-secondary)]">{items.length} 个变更</span>
        <span className="text-[var(--ema-success-text)]">+{totals.additions}</span>
        <span className="text-[var(--ema-danger-text)]">-{totals.deletions}</span>
        {totals.omitted > 0 && (
          <span className="text-[var(--ema-warning-text)]" title="超出单文件或总量上限,未包含在本次 diff 中">
            {totals.omitted} 个未显示
          </span>
        )}

        <span className="flex-1" />

        <Input
          inputSize="sm"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="跳转到文件…"
          className="w-36"
          aria-label="按路径过滤并跳转"
        />
        <IconButton
          size="sm"
          label={view === 'diff' ? '文件清单视图' : '差异视图'}
          icon={view === 'diff' ? 'i-lucide:list' : 'i-lucide:file-diff'}
          toggled={view === 'files'}
          onClick={() => setView(view === 'diff' ? 'files' : 'diff')}
        />
        <IconButton
          size="sm"
          label="分列差异"
          icon="i-lucide:columns-2"
          toggled={split}
          onClick={() => setSplit((value) => !value)}
        />
        <IconButton
          size="sm"
          label="自动换行"
          icon="i-lucide:wrap-text"
          toggled={wrap}
          onClick={() => setWrap((value) => !value)}
        />
        {gitAvailable && (scope === 'unstaged' || scope === 'staged') && (
          <IconButton
            size="sm"
            label="刷新工作区 diff"
            icon="i-lucide:refresh-cw"
            loading={workspaceLoading}
            onClick={refreshWorkspace}
          />
        )}
      </div>

      {items.length === 0 ? (
        <ScopeEmpty
          scope={scope}
          allCount={allDiffs.length}
          loading={workspaceLoading}
          onShowAll={() => setScope('all')}
        />
      ) : view === 'files' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <div className="flex flex-col gap-0.5">
            {visibleItems.map((item) => (
              <button
                key={item.key}
                className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--ema-surface-2)]"
                onClick={() => jumpToFile(item.key)}
              >
                <span className="i-lucide:file-diff shrink-0 text-sm text-[var(--ema-text-tertiary)]" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--ema-text-secondary)]" title={item.displayPath}>
                  {item.displayPath}
                </span>
                <span className="shrink-0 text-[11px] text-[var(--ema-success-text)]">+{item.additions}</span>
                <span className="shrink-0 text-[11px] text-[var(--ema-danger-text)]">-{item.deletions}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
          <div className="flex flex-col gap-1.5">
            {visibleItems.map((item) => (
              <DiffCard
                key={item.key}
                item={item}
                expanded={activeKey === item.key}
                split={split}
                wrap={wrap}
                onToggle={() => setActiveKey((current) => (current === item.key ? null : item.key))}
                onOpenFile={openFile}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function gitFileToItem(scope: 'unstaged' | 'staged', file: GitDiffFile): ReviewFileItem {
  return {
    key: `git:${scope}:${file.path}`,
    displayPath: file.path,
    absolutePath: file.absolutePath,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    unifiedDiff: file.unifiedDiff,
    truncated: file.truncated,
  };
}

function ScopeEmpty({
  scope, allCount, loading, onShowAll,
}: {
  scope: ReviewScope;
  allCount: number;
  loading: boolean;
  onShowAll: () => void;
}): JSX.Element {
  const message = scope === 'latest'
    ? '上一轮还没有文件变更'
    : scope === 'all'
      ? '当前 Session 还没有文件变更'
      : scope === 'unstaged'
        ? '工作区没有未暂存变更'
        : '没有已暂存变更';
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-[var(--ema-text-tertiary)]">
      <span className="i-lucide:file-diff text-2xl opacity-40" aria-hidden />
      <span>{loading ? '正在读取工作区 diff…' : message}</span>
      {!loading && scope === 'latest' && allCount > 0 && (
        <Button variant="ghost" size="sm" onClick={onShowAll}>
          查看全部会话({allCount})
        </Button>
      )}
    </div>
  );
}
