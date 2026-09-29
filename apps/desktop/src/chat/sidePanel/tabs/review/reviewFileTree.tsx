// 只把官方 diff 的真实路径/状态接入官方 Trees, 不构建或递归渲染自己的树.
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
} from 'react';
import type { ChangeTypes, FileDiffMetadata } from '@pierre/diffs';
import type { GitStatus } from '@pierre/trees';
import {
  FileTree,
  useFileTree,
  type UseFileTreeResult,
} from '@pierre/trees/react';
import { Input } from '@ema-agent/ui';
import treeCSS from '../../../../styles/vendors/fileTree.css?inline';

const CHANGE_STATUS: Record<ChangeTypes, GitStatus> = {
  change: 'modified',
  new: 'added',
  deleted: 'deleted',
  'rename-pure': 'renamed',
  'rename-changed': 'renamed',
};

interface ReviewFileTreeProps {
  files: readonly FileDiffMetadata[];
  onSelect: (filePath: string) => void;
}

export const ReviewFileTree = memo(function ReviewFileTree({
  files,
  onSelect,
}: ReviewFileTreeProps): JSX.Element {
  const [filter, setFilter] = useState('');
  const select = useCallback((paths: readonly string[]): void => {
    const path = paths.at(-1);
    if (path && model.getItem(path)?.isDirectory() === false) {
      onSelect(path);
    }
  }, [onSelect]);
  const { model }: UseFileTreeResult = useFileTree({
    paths: [],
    density: 'compact',
    icons: 'complete',
    initialExpansion: 'open',
    flattenEmptyDirectories: true,
    stickyFolders: false,
    search: false,
    fileTreeSearchMode: 'hide-non-matches',
    onSelectionChange: select,
    unsafeCSS: treeCSS,
  });
  // Git 文件名不能含 NUL. 内容更新但路径集合相同时, 不重置目录展开状态.
  const pathList = useMemo(() => files.map(file => file.name).join('\0'), [files]);
  const gitStatus = useMemo(() => (
    files.map(file => ({
      path: file.name,
      status: CHANGE_STATUS[file.type],
    }))
  ), [files]);

  useEffect(() => {
    const expanded = model
      .getVisibleRows(0, model.getVisibleCount())
      .filter(row => row.kind === 'directory' && row.isExpanded)
      .flatMap(row => row.flattenedSegments?.map(segment => segment.path) ?? [row.path]);
    const paths = pathList ? pathList.split('\0') : [];
    if (model.getVisibleCount() === 0) {
      model.resetPaths(paths);
    } else {
      model.resetPaths(paths, { initialExpandedPaths: expanded });
    }
  }, [model, pathList]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

  useEffect(() => {
    model.setSearch(filter || null);
  }, [model, filter]);

  return (
    <div className="ema-review-tree">
      <div className="ema-review-tree-search">
        <span className="i-lucide:search pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm text-[var(--ema-text-tertiary)]" aria-hidden />
        <Input
          inputSize="sm"
          mono={false}
          value={filter}
          onChange={event => setFilter(event.target.value)}
          placeholder="筛选文件…"
          aria-label="按路径筛选文件"
          className="w-full rounded-lg pl-7"
          spellCheck={false}
        />
      </div>
      {/* React 18 对自定义元素的 className 不生成 class, 布局类留在标准元素上. */}
      <div className="ema-review-tree-view">
        <FileTree
          model={model}
          style={{
            height: '100%',
            minHeight: 0,
            width: '100%',
          }}
          aria-label="变更文件树"
        />
      </div>
    </div>
  );
});
