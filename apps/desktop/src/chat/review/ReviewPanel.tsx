// 审阅面板:上一轮/全部会话走工具结果 data 槽(Edit/Write 的 structuredPatch),
// 未暂存/已暂存走 Git 工作区 diff,提交记录/分支比较走 git-compare;没有真实来源的范围不渲染。
// git 数据源待后端恢复：/api/git 路由已随 api/git.js 删除，以下 git 状态恒为空，
// 范围状态机、比较选择与 diff 渲染结构原样保留，恢复时只需重新接回数据拉取。
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Button, DropdownMenu, IconButton, Input } from '@ema-agent/ui';
import type {
  GitCompareResult,
  GitDiffFile,
  GitRefsResult,
  GitWorkspaceDiffResult,
} from '@ema-agent/git';

import { useWorkspaceStore } from '../../stores/workspaceStore.js';
import { fileTab } from '../../stores/workspaceTypes.js';
import { useLatestTurnDiffs, useSessionDiffs } from './reviewDiffs.js';
import { DiffCard, type ReviewFileItem } from './DiffCard.js';

type ReviewScope = 'latest' | 'all' | 'unstaged' | 'staged' | 'commit' | 'branch';
type PanelView = 'diff' | 'files';

interface CompareTarget {
  readonly type: 'commit' | 'branch';
  readonly ref: string;
  readonly label: string;
}

const SCOPE_LABEL: Record<ReviewScope, string> = {
  latest:   '上一轮',
  all:      '全部会话',
  unstaged: '未暂存',
  staged:   '已暂存',
  commit:   '提交记录',
  branch:   '分支比较',
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
  // 分支/提交清单与比较结果:同样 capability 裁决,非 ok 不渲染对应范围。
  const [refs, setRefs] = useState<GitRefsResult | null>(null);
  const [compareTarget, setCompareTarget] = useState<CompareTarget | null>(null);
  const [compare, setCompare] = useState<GitCompareResult | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);

  useEffect(() => {
    setWorkspaceDiff(null);
    setRefs(null);
    setWorkspaceLoading(false);
  }, [sessionId]);

  // 比较目标变化时重新评估 git-compare（git 数据源待后端恢复，当前恒为空态）。
  useEffect(() => {
    setCompare(null);
    setCompareLoading(false);
  }, [sessionId, compareTarget]);

  const refreshWorkspace = (): void => {
    // git 数据源待后端恢复：恢复后在此重新拉取 workspace diff 与 compare。
    setWorkspaceDiff(null);
    setCompare(null);
    setWorkspaceLoading(false);
    setCompareLoading(false);
  };

  const gitAvailable = workspaceDiff?.capability === 'ok';
  const refsAvailable = refs?.capability === 'ok';
  // 分支比较候选:排除当前分支(与自身比较恒为空)。
  const compareBranches = useMemo(
    () => refsAvailable ? refs.branches.filter((b) => b !== refs.current) : [],
    [refsAvailable, refs],
  );
  const compareCommits = useMemo(
    () => refsAvailable ? refs.commits : [],
    [refsAvailable, refs],
  );

  // 当前范围失去数据来源时回退上一轮,不展示空壳。
  useEffect(() => {
    if ((scope === 'unstaged' || scope === 'staged') && workspaceDiff !== null && !gitAvailable) {
      setScope('latest');
    }
    if (scope === 'commit' && refs !== null && compareCommits.length === 0) setScope('latest');
    if (scope === 'branch' && refs !== null && compareBranches.length === 0) setScope('latest');
  }, [scope, workspaceDiff, gitAvailable, refs, compareCommits.length, compareBranches.length]);

  const items = useMemo<readonly ReviewFileItem[]>(() => {
    if (scope === 'unstaged' || scope === 'staged') {
      if (workspaceDiff?.capability !== 'ok') return [];
      return workspaceDiff[scope].files.map((file) => gitFileToItem(scope, file));
    }
    if (scope === 'commit' || scope === 'branch') {
      if (!compareTarget || compare?.capability !== 'ok') return [];
      return compare.diff.files.map((file) => gitFileToItem(scope, file));
    }
    const diffs = scope === 'latest' ? latestDiffs : allDiffs;
    return diffs.map((diff) => ({
      key: diff.callId,
      displayPath: diff.filePath,
      absolutePath: diff.filePath,
      status: diff.status === 'created' ? 'added' as const : 'modified' as const,
      additions: diff.additions,
      deletions: diff.deletions,
      unifiedDiff: diff.unifiedDiff,
      truncated: false,
    }));
  }, [scope, workspaceDiff, compareTarget, compare, latestDiffs, allDiffs]);

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
    if ((scope === 'commit' || scope === 'branch') && compare?.capability === 'ok') {
      return {
        additions: compare.diff.totalAdditions,
        deletions: compare.diff.totalDeletions,
        omitted: compare.diff.omittedFiles,
      };
    }
    return {
      additions: items.reduce((sum, item) => sum + item.additions, 0),
      deletions: items.reduce((sum, item) => sum + item.deletions, 0),
      omitted: 0,
    };
  }, [scope, workspaceDiff, compare, items]);

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
    if (sessionId) openTab(sessionId, fileTab(absolutePath));
  };

  const jumpToFile = (key: string): void => {
    setFilter('');
    setView('diff');
    setActiveKey(key);
    setPendingScrollKey(key);
  };

  const scopeOptions: readonly ReviewScope[] = [
    'latest',
    'all',
    ...(gitAvailable ? (['unstaged', 'staged'] as const) : []),
    ...(compareCommits.length > 0 ? (['commit'] as const) : []),
    ...(compareBranches.length > 0 ? (['branch'] as const) : []),
  ];

  // 切到比较范围时,默认选中第一个候选,不给"未选择"的空壳状态。
  const selectScope = (option: ReviewScope): void => {
    setScope(option);
    if (option === 'commit' && compareTarget?.type !== 'commit') {
      const first = compareCommits[0];
      if (first) {
        setCompareTarget({
          type: 'commit',
          ref: first.sha,
          label: `${first.sha.slice(0, 7)} ${first.subject}`,
        });
      }
    }
    if (option === 'branch' && compareTarget?.type !== 'branch') {
      const first = compareBranches[0];
      if (first) setCompareTarget({ type: 'branch', ref: first, label: first });
    }
  };

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
            onSelect: () => selectScope(option),
          }))}
        />
        {/* 二级选择器:提交记录选提交,分支比较选基准分支。 */}
        {scope === 'commit' && (
          <DropdownMenu
            side="bottom"
            align="start"
            widthClass="min-w-64 max-w-80"
            trigger={(
              <Button variant="ghost" size="sm" className="gap-1 max-w-64 truncate px-2 py-0.5 text-[11px]">
                <span className="truncate">{compareTarget?.type === 'commit' ? compareTarget.label : '选择提交'}</span>
                <span className="i-lucide:chevron-down shrink-0 text-xs" aria-hidden />
              </Button>
            )}
            items={compareCommits.map((commit) => ({
              kind: 'item' as const,
              label: `${commit.sha.slice(0, 7)} ${commit.subject}`,
              onSelect: () => setCompareTarget({
                type: 'commit',
                ref: commit.sha,
                label: `${commit.sha.slice(0, 7)} ${commit.subject}`,
              }),
            }))}
          />
        )}
        {scope === 'branch' && (
          <DropdownMenu
            side="bottom"
            align="start"
            widthClass="min-w-40"
            trigger={(
              <Button variant="ghost" size="sm" className="gap-1 max-w-48 truncate px-2 py-0.5 text-[11px]">
                <span className="truncate">
                  {compareTarget?.type === 'branch' ? `相对 ${compareTarget.label}` : '选择基准分支'}
                </span>
                <span className="i-lucide:chevron-down shrink-0 text-xs" aria-hidden />
              </Button>
            )}
            items={compareBranches.map((branch) => ({
              kind: 'item' as const,
              label: branch,
              onSelect: () => setCompareTarget({ type: 'branch', ref: branch, label: branch }),
            }))}
          />
        )}
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
        {((gitAvailable && (scope === 'unstaged' || scope === 'staged'))
          || ((scope === 'commit' || scope === 'branch') && compareTarget)) && (
          <IconButton
            size="sm"
            label="刷新 diff"
            icon="i-lucide:refresh-cw"
            loading={workspaceLoading || compareLoading}
            onClick={refreshWorkspace}
          />
        )}
      </div>

      {items.length === 0 ? (
        <ScopeEmpty
          scope={scope}
          allCount={allDiffs.length}
          loading={workspaceLoading || compareLoading}
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

function gitFileToItem(scope: string, file: GitDiffFile): ReviewFileItem {
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
        : scope === 'staged'
          ? '没有已暂存变更'
          : '与该基准没有差异';
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
