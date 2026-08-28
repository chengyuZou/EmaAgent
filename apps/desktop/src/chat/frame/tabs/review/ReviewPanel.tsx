// 审阅面板:上一轮/全部会话的文件变更，来自工具结果 data 槽(Edit/Write 的 structuredPatch)。
// V1 只呈现已有 Session Tool diff；Git 工作区/提交/分支范围等真实 Git Route 出现后再加。
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Button, DropdownMenu, IconButton, Input } from '@ema-agent/ui';

import { useDockTabs, fileTab } from '../../dockTabs.js';
import { useLatestTurnDiffs, useSessionDiffs } from './reviewDiffs.js';
import { DiffCard, type ReviewFileItem } from './DiffCard.js';

type ReviewScope = 'latest' | 'all';
type PanelView = 'diff' | 'files';

const SCOPE_LABEL: Record<ReviewScope, string> = {
  latest: '上一轮',
  all:    '全部会话',
};

export function ReviewPanel({ sessionId }: { sessionId: string | null }): JSX.Element {
  const openTab = useDockTabs((s) => s.openTab);

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

  const items = useMemo<readonly ReviewFileItem[]>(() => {
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
  }, [scope, latestDiffs, allDiffs]);

  const visibleItems = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) => item.displayPath.toLowerCase().includes(query));
  }, [items, filter]);

  const totals = useMemo(() => ({
    additions: items.reduce((sum, item) => sum + item.additions, 0),
    deletions: items.reduce((sum, item) => sum + item.deletions, 0),
  }), [items]);

  // 进入时默认定位到首个变更；当前选中项随数据变化失效时回退到首项。
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

  const scopeOptions: readonly ReviewScope[] = ['latest', 'all'];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--ema-border)] px-3 py-2 text-xs">
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
      </div>

      {items.length === 0 ? (
        <ScopeEmpty
          scope={scope}
          allCount={allDiffs.length}
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

function ScopeEmpty({
  scope, allCount, onShowAll,
}: {
  scope: ReviewScope;
  allCount: number;
  onShowAll: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-[var(--ema-text-tertiary)]">
      <span className="i-lucide:file-diff text-2xl opacity-40" aria-hidden />
      <span>{scope === 'latest' ? '上一轮还没有文件变更' : '当前 Session 还没有文件变更'}</span>
      {scope === 'latest' && allCount > 0 && (
        <Button variant="ghost" size="sm" onClick={onShowAll}>
          查看全部会话({allCount})
        </Button>
      )}
    </div>
  );
}
