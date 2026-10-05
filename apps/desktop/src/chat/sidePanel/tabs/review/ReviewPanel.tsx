// Git 返回原生 patch; 官方 CodeView 管理 diff 虚拟化、行内高亮和文件布局.
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
} from 'react';
import {
  type CodeViewItem,
  type FileDiffMetadata,
} from '@pierre/diffs';
import {
  CodeView,
  WorkerPoolContextProvider,
  type CodeViewHandle,
  type CodeViewReactOptions,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from '@pierre/diffs/react';
import DiffWorker from '@pierre/diffs/worker/worker.js?worker';
import { createFileTreeIconResolver, getBuiltInSpriteSheet } from '@pierre/trees';
import {
  Button,
  IconButton,
  Select,
  Spinner,
  Tooltip,
  toast,
  type SelectOption,
} from '@ema-agent/ui';
import type { GitDiffScope } from '../../../../api/git.js';
import { useSessionStore } from '../../../../stores/session.js';
import { fileTab, useSessionPanelStore } from '../../../../stores/sessionPanel.js';
import { ReviewFileTree } from './reviewFileTree.js';
import { useReviewGitDiff, useSessionGitDiff } from '../../../session/gitDiffContext.js';
import diffCSS from '@ema-agent/builtin-tools/fileDiff.css?inline';

const EMPTY_FILES: FileDiffMetadata[] = [];
const EMPTY_ITEMS: CodeViewItem<undefined>[] = [];
const FILE_HEADER_HEIGHT = 32;
const POOL_OPTIONS: WorkerPoolOptions = {
  workerFactory: () => new DiffWorker({ name: 'ema-review-highlighter' }),
  poolSize: 2,
};
const HIGHLIGHTER_OPTIONS: WorkerInitializationRenderOptions = {
  theme: {
    light: 'github-light',
    dark: 'github-dark',
  },
  lineDiffType: 'word-alt',
};
const FILE_ICONS = createFileTreeIconResolver('complete');
const FILE_ICON_SPRITE = getBuiltInSpriteSheet('complete');
const SCOPE_OPTIONS: SelectOption[] = [
  { value: 'uncommitted', label: '全部未提交' },
  { value: 'staged', label: '已暂存' },
  { value: 'unstaged', label: '未暂存' },
];

export function ReviewPanel({ sessionId }: { sessionId: string }): JSX.Element {
  const cwd = useSessionStore(state => state.sessions.byId.get(sessionId)?.cwd);
  const { reviewScope: scope, setReviewScope: setScope } = useSessionGitDiff();
  const [split, setSplit] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [filesOpen, setFilesOpen] = useState(true);
  const toggleSplit = useCallback(() => setSplit(value => !value), []);
  const toggleWrap = useCallback(() => setWrap(value => !value), []);
  const toggleFiles = useCallback(() => setFilesOpen(value => !value), []);

  return (
    <WorkerPoolContextProvider
      poolOptions={POOL_OPTIONS}
      highlighterOptions={HIGHLIGHTER_OPTIONS}
    >
      {/* 只有执行上下文切换才重建查询和实例, 展示偏好在外层保留. */}
      <ReviewWorkspace
        key={JSON.stringify([sessionId, cwd, scope])}
        sessionId={sessionId}
        scope={scope}
        split={split}
        wrap={wrap}
        filesOpen={filesOpen}
        onScope={setScope}
        onSplit={toggleSplit}
        onWrap={toggleWrap}
        onFiles={toggleFiles}
      />
    </WorkerPoolContextProvider>
  );
}

interface ReviewWorkspaceProps {
  sessionId: string;
  scope: GitDiffScope;
  split: boolean;
  wrap: boolean;
  filesOpen: boolean;
  onScope: (scope: GitDiffScope) => void;
  onSplit: () => void;
  onWrap: () => void;
  onFiles: () => void;
}

function ReviewWorkspace({
  sessionId,
  scope,
  split,
  wrap,
  filesOpen,
  onScope,
  onSplit,
  onWrap,
  onFiles,
}: ReviewWorkspaceProps): JSX.Element {
  const openTab = useSessionPanelStore(state => state.openTab);
  const { data, loading, error: requestError } = useReviewGitDiff(scope);
  const { refresh: requestRefresh } = useSessionGitDiff();
  const result = data?.result ?? null;
  const files = data?.files ?? EMPTY_FILES;
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [themeType, setThemeType] = useState<'light' | 'dark'>(() => {
    if (typeof document === 'undefined' || document.documentElement.dataset.theme === 'light') {
      return 'light';
    }
    return 'dark';
  });
  const viewerRef = useRef<CodeViewHandle<undefined, undefined>>(null);
  const treeId = useId();

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setThemeType(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    const items = files.map(fileDiff => {
      const id = `${scope}:${fileDiff.name}`;
      const previous = viewer?.getItem(id);
      return {
        id,
        type: 'diff' as const,
        fileDiff,
        version: (previous?.version ?? 0) + 1,
        collapsed: previous?.collapsed ?? false,
      };
    });
    // 原生 id 的协调、布局缓存和实例回收交给 CodeView, 不维护第二份 item Map.
    viewer?.getInstance()?.setItems(items);
    setAllCollapsed(items.length > 0 && items.every(item => item.collapsed));
  }, [files, scope]);

  const syncAllCollapsed = useCallback(() => {
    setAllCollapsed(files.length > 0 && files.every(file => (
      viewerRef.current?.getItem(`${scope}:${file.name}`)?.collapsed === true
    )));
  }, [files, scope]);

  const toggleFile = useCallback((id: string) => {
    const item = viewerRef.current?.getItem(id);
    if (!item) {
      return;
    }
    viewerRef.current?.updateItem({
      ...item,
      collapsed: !item.collapsed,
      version: (item.version ?? 0) + 1,
    });
    syncAllCollapsed();
  }, [syncAllCollapsed]);

  const toggleAllFiles = useCallback(() => {
    const viewer = viewerRef.current;
    const items = files.flatMap(file => {
      const item = viewer?.getItem(`${scope}:${file.name}`);
      return item ? [item] : [];
    });
    const collapsed = items.some(item => !item.collapsed);
    // 一次协调全部文件, 不逐个更新触发重复的布局和渲染.
    viewer?.getInstance()?.setItems(items.map(item => {
      if (item.collapsed === collapsed) {
        return item;
      }
      return {
        ...item,
        collapsed,
        version: (item.version ?? 0) + 1,
      };
    }));
    setAllCollapsed(collapsed);
  }, [files, scope]);

  const locateFile = useCallback((filePath: string) => {
    const id = `${scope}:${filePath}`;
    const viewer = viewerRef.current;
    const item = viewer?.getItem(id);
    if (!item) {
      return;
    }
    if (item.collapsed) {
      viewer?.updateItem({
        ...item,
        collapsed: false,
        version: (item.version ?? 0) + 1,
      });
      syncAllCollapsed();
    }
    viewer?.scrollTo({
      type: 'item',
      id,
      align: 'start',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
  }, [scope, syncAllCollapsed]);

  const repoRoot = result?.capability === 'ok' ? result.repoRoot : null;
  const openFile = useCallback((filePath: string) => {
    if (repoRoot) {
      openTab(sessionId, fileTab(`${repoRoot.replace(/[\\/]$/, '')}/${filePath}`));
    }
  }, [repoRoot, openTab, sessionId]);

  const renderHeader = useCallback((item: CodeViewItem<undefined>) => {
    if (item.type !== 'diff') {
      return null;
    }
    return <ReviewFileHeader item={item} onToggle={toggleFile} onOpen={openFile} />;
  }, [toggleFile, openFile]);

  const options = useMemo<CodeViewReactOptions<undefined, undefined>>(() => ({
    theme: HIGHLIGHTER_OPTIONS.theme,
    themeType,
    diffStyle: split ? 'split' : 'unified',
    overflow: wrap ? 'wrap' : 'scroll',
    lineDiffType: 'word-alt',
    hunkSeparators: 'line-info',
    unsafeCSS: diffCSS,
    stickyHeaders: true,
    itemMetrics: { diffHeaderHeight: FILE_HEADER_HEIGHT },
    layout: { paddingTop: 8, paddingBottom: 8, gap: 2 },
  }), [split, wrap, themeType]);
  const counts = { additions: data?.additions ?? 0, deletions: data?.deletions ?? 0 };

  let message: string | null = requestError;
  if (!message && result) {
    if (result.capability === 'diff-too-large') {
      message = '差异过大, 暂不展示. 缩小工作区变更范围后可以刷新重试.';
    } else if (result.capability === 'not-a-repo') {
      message = '当前 Session 的执行目录不在 Git 仓库中';
    } else if (result.capability === 'git-unavailable') {
      message = '本机没有可用的 Git';
    } else if (result.capability === 'error') {
      message = 'Git 差异读取失败';
    } else if (files.length === 0 && result.omittedFiles > 0) {
      message = `有 ${result.omittedFiles} 个文件未能读取`;
    } else if (files.length === 0) {
      message = '工作区没有文件变更';
    }
  }

  return (
    <div className="ema-review-panel flex h-full min-h-0 flex-col" data-scope={scope}>
      <span aria-hidden className="hidden" dangerouslySetInnerHTML={{ __html: FILE_ICON_SPRITE }} />
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--ema-border)] px-2 py-1.5 text-xs">
        <div className="min-w-0 flex flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-medium text-[var(--ema-text-primary)]">工作区变更</span>
          <Select
            className="ema-review-scope h-7 w-auto shrink-0 gap-1 rounded-pill border-0 px-2 text-xs shadow-none"
            aria-label="变更范围"
            value={scope}
            options={SCOPE_OPTIONS}
            trigger={SCOPE_OPTIONS.find(option => option.value === scope)?.label}
            chevronIcon="i-lucide:chevron-down"
            checkIcon="i-lucide:check"
            onChange={value => onScope(value as GitDiffScope)}
          />
          {result?.capability === 'ok' && (
            <>
              <span className="text-[var(--ema-text-secondary)]">{files.length} 项变更</span>
              <span className="text-[var(--ema-success-text)]">+{counts.additions}</span>
              <span className="text-[var(--ema-danger-text)]">-{counts.deletions}</span>
            </>
          )}
        </div>
        <div
          className="ema-review-actions ml-auto flex shrink-0 items-center gap-0.5 rounded-pill bg-[var(--ema-surface-2)] p-0.5"
          role="group"
          aria-label="审查视图操作"
        >
          <Tooltip content="刷新" side="bottom">
            <IconButton
              size="sm"
              variant="ghost"
              className="ema-review-action"
              label="刷新 Git 差异"
              icon="i-review:reviewRefresh"
              disabled={loading}
              aria-busy={loading}
              onClick={requestRefresh}
            />
          </Tooltip>
          <Tooltip content={wrap ? '关闭自动换行' : '启用自动换行'} side="bottom">
            <IconButton
              size="sm"
              variant="ghost"
              className="ema-review-action"
              label={wrap ? '关闭自动换行' : '启用自动换行'}
              icon={wrap ? 'i-review:reviewWrapOn' : 'i-review:reviewWrapOff'}
              toggled={wrap}
              aria-pressed={wrap}
              onClick={onWrap}
            />
          </Tooltip>
          <Tooltip content={allCollapsed ? '展开全部差异' : '折叠全部差异'} side="bottom">
            <IconButton
              size="sm"
              variant="ghost"
              className="ema-review-action"
              label={allCollapsed ? '展开全部差异' : '折叠全部差异'}
              icon={allCollapsed ? 'i-review:reviewExpandAll' : 'i-review:reviewCollapseAll'}
              disabled={files.length === 0}
              aria-pressed={allCollapsed}
              onClick={toggleAllFiles}
            />
          </Tooltip>
          <Tooltip content={split ? '切换为统一差异' : '切换为分列差异'} side="bottom">
            <IconButton
              size="sm"
              variant="ghost"
              className="ema-review-action"
              label={split ? '切换为统一差异' : '切换为分列差异'}
              icon={split ? 'i-review:reviewSplit' : 'i-review:reviewUnified'}
              toggled={split}
              aria-pressed={split}
              onClick={onSplit}
            />
          </Tooltip>
          <Tooltip content={filesOpen ? '隐藏文件树' : '显示文件树'} side="bottom">
            <IconButton
              size="sm"
              variant="ghost"
              className="ema-review-action"
              label={filesOpen ? '隐藏文件树' : '显示文件树'}
              icon="i-review:reviewFiles"
              toggled={filesOpen}
              aria-pressed={filesOpen}
              aria-expanded={filesOpen}
              aria-controls={treeId}
              onClick={onFiles}
            />
          </Tooltip>
        </div>
      </div>
      {requestError && files.length > 0 && (
        <p className="ema-review-notice" role="status">
          刷新失败: {requestError}
        </p>
      )}
      {result?.capability === 'ok' && result.omittedFiles > 0 && files.length > 0 && (
        <p className="ema-review-notice" role="status">
          有 {result.omittedFiles} 个文件未能读取
        </p>
      )}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="ema-review-content">
          <CodeView
            ref={viewerRef}
            initialItems={EMPTY_ITEMS}
            options={options}
            renderCustomHeader={renderHeader}
            className="ema-review-viewport"
          />
          {files.length === 0 && (
            <div className="ema-review-empty">
              {loading ? <Spinner size="md" label="正在读取 Git 差异" /> : message}
            </div>
          )}
        </div>
        <aside
          id={treeId}
          className="ema-review-tree-pane"
          data-open={filesOpen}
          aria-label="变更文件"
          aria-hidden={!filesOpen}
          {...(filesOpen ? {} : { inert: '' })}
        >
          <ReviewFileTree files={files} onSelect={locateFile} />
        </aside>
      </div>
    </div>
  );
}

interface ReviewFileHeaderProps {
  item: Extract<CodeViewItem<undefined>, { type: 'diff' }>;
  onToggle: (id: string) => void;
  onOpen: (filePath: string) => void;
}

const ReviewFileHeader = memo(function ReviewFileHeader({
  item,
  onToggle,
  onOpen,
}: ReviewFileHeaderProps): JSX.Element {
  const file = item.fileDiff;
  const separator = file.name.lastIndexOf('/');
  const directory = file.name.slice(0, separator + 1);
  const fileName = file.name.slice(separator + 1);
  const icon = FILE_ICONS.resolveIcon('file-tree-icon-file', file.name);
  const counts = useMemo(() => (
    file.hunks.reduce((total, hunk) => ({
      additions: total.additions + hunk.additionLines,
      deletions: total.deletions + hunk.deletionLines,
    }), {
      additions: 0,
      deletions: 0,
    })
  ), [file]);
  const toggle = useCallback(() => onToggle(item.id), [onToggle, item.id]);
  const stopActionClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  }, []);
  const open = useCallback(() => onOpen(file.name), [onOpen, file.name]);
  const copyPath = useCallback(() => {
    void navigator.clipboard.writeText(file.name).then(
      () => toast.success('已复制文件路径'),
      () => toast.error('复制文件路径失败'),
    );
  }, [file.name]);
  const toggleLabel = `${item.collapsed ? '展开差异' : '折叠差异'} ${file.name}`;

  return (
    <div
      className="ema-review-file-header"
      data-review-key={item.id}
      style={{ height: FILE_HEADER_HEIGHT }}
      onClick={toggle}
    >
      <Tooltip content={file.name} variant="card" className="break-all" side="bottom" align="start">
        <Button
          size="sm"
          variant="ghost"
          className="ema-review-file-heading"
          aria-expanded={!item.collapsed}
        >
          <svg
            width="16"
            height="16"
            viewBox={icon.viewBox ?? '0 0 16 16'}
            className="shrink-0"
            aria-hidden
          >
            <use href={`#${icon.name}`} />
          </svg>
          <span className="ema-review-file-path">
            {directory && (
              <span className="ema-review-file-directory">{directory}</span>
            )}
            <span className="ema-review-file-name">
              {fileName}
            </span>
          </span>
          <span className="ema-review-file-counts">
            <span className="text-[var(--ema-success-text)]">+{counts.additions}</span>
            <span className="text-[var(--ema-danger-text)]">-{counts.deletions}</span>
          </span>
        </Button>
      </Tooltip>
      {file.hunks.length === 0 && (
        <span className="ema-review-file-note">无文本差异</span>
      )}
      {/* 操作按钮不冒泡到标题条, 折叠按钮也只切换一次. */}
      <div
        className="ema-review-file-actions"
        role="group"
        aria-label={`文件操作 ${file.name}`}
        onClick={stopActionClick}
      >
        <Tooltip content="复制文件路径" side="bottom">
          <IconButton
            size="sm"
            variant="ghost"
            shape="rounded"
            className="ema-review-file-action"
            label={`复制文件路径 ${file.name}`}
            icon="i-lucide:copy"
            onClick={copyPath}
          />
        </Tooltip>
        <Tooltip content={item.collapsed ? '展开差异' : '折叠差异'} side="bottom">
          <IconButton
            size="sm"
            variant="ghost"
            shape="rounded"
            className="ema-review-file-action"
            label={toggleLabel}
            icon={item.collapsed ? 'i-lucide:chevron-right' : 'i-lucide:chevron-down'}
            aria-expanded={!item.collapsed}
            onClick={toggle}
          />
        </Tooltip>
        {file.type !== 'deleted' && (
          <Tooltip content="在标签页中打开文件" side="bottom">
            <IconButton
              size="sm"
              variant="ghost"
              shape="rounded"
              className="ema-review-file-action"
              label={`打开文件 ${file.name}`}
              icon="i-lucide:square-arrow-out-up-right"
              onClick={open}
            />
          </Tooltip>
        )}
      </div>
    </div>
  );
});
