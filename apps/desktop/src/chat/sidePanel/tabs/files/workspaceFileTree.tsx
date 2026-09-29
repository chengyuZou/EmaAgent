// 文件系统按需读目录; 官方 Trees 管理路径、展开、搜索、选择和虚拟行, 滚动修复共用依赖 patch.
import { memo, useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { Button, Input } from '@ema-agent/ui';
import { ServerApiError } from '../../../../api/client.js';
import { filesApi } from '../../../../api/workspaces.js';
import treeCSS from '../../../../styles/vendors/fileTree.css?inline';

type DirectoryRead =
  | { state: 'loading'; controller: AbortController }
  | { state: 'loaded' }
  | { state: 'failed' };

interface WorkspaceFileTreeProps {
  root: string;
  selectedPath: string | null;
  onOpen: (path: string) => void;
}

function directoryError(cause: unknown): string {
  if (cause instanceof ServerApiError) {
    if (cause.code === 'path_not_found') return '目录不存在';
    if (cause.code === 'access_denied') return '没有读取权限';
    if (cause.code === 'not_a_directory') return '所选路径不是目录';
  }
  return cause instanceof Error ? cause.message : '读取失败';
}

export const WorkspaceFileTree = memo(function WorkspaceFileTree({
  root,
  selectedPath,
  onOpen,
}: WorkspaceFileTreeProps): JSX.Element {
  const [filter, setFilter] = useState('');
  const [pendingCount, setPendingCount] = useState(0);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const directoryReads = useRef(new Map<string, DirectoryRead>());
  const syncingSelection = useRef(false);
  const rootPath = root.replaceAll('\\', '/').replace(/\/+$/, '');
  const open = useCallback((paths: readonly string[]) => {
    if (syncingSelection.current) return;
    const path = paths.at(-1);
    if (path && model.getItem(path)?.isDirectory() === false) {
      onOpen(`${rootPath}/${path}`);
    }
  }, [onOpen, rootPath]);
  const { model } = useFileTree({
    paths: [],
    density: 'compact',
    icons: 'complete',
    initialExpansion: 'closed',
    // 目录未读取时不能把单子目录链压扁, 否则改变按需加载的点击目标.
    flattenEmptyDirectories: false,
    stickyFolders: false,
    search: false,
    fileTreeSearchMode: 'hide-non-matches',
    onSelectionChange: open,
    unsafeCSS: treeCSS,
  });

  const loadDirectory = useCallback(async (path: string): Promise<void> => {
    if (directoryReads.current.has(path)) return;
    const controller = new AbortController();
    directoryReads.current.set(path, { state: 'loading', controller });
    setPendingCount(value => value + 1);
    try {
      const directory = path ? `${rootPath}/${path}` : `${rootPath}/`;
      const { entries } = await filesApi.ls(directory, controller.signal);
      if (controller.signal.aborted) return;
      directoryReads.current.set(path, { state: 'loaded' });
      // 目录用尾斜杠声明, 不插入虚假占位文件; 加载后保留库已有展开状态.
      const prefix = path && !path.endsWith('/') ? `${path}/` : path;
      model.batch(entries.map(entry => ({
        type: 'add' as const,
        path: `${prefix}${entry.name}${entry.type === 'dir' ? '/' : ''}`,
      })));
      setErrors(previous => {
        const next = { ...previous };
        delete next[path];
        return next;
      });
    } catch (cause) {
      if (controller.signal.aborted) return;
      directoryReads.current.set(path, { state: 'failed' });
      setErrors(previous => ({ ...previous, [path]: directoryError(cause) }));
    } finally {
      if (!controller.signal.aborted) setPendingCount(value => value - 1);
    }
  }, [model, rootPath]);

  useEffect(() => {
    const loadExpandedDirectories = () => {
      for (const row of model.getVisibleRows(0, model.getVisibleCount())) {
        if (row.kind === 'directory' && row.isExpanded) {
          void loadDirectory(row.path);
        }
      }
    };
    const unsubscribe = model.subscribe(loadExpandedDirectories);
    void loadDirectory('');
    return () => {
      unsubscribe();
      for (const [path, read] of directoryReads.current) {
        if (read.state === 'loading') {
          read.controller.abort();
          directoryReads.current.delete(path);
        }
      }
      setPendingCount(0);
    };
  }, [model, loadDirectory]);

  useEffect(() => model.setSearch(filter || null), [model, filter]);

  useEffect(() => {
    const normalized = selectedPath?.replaceAll('\\', '/');
    const path = normalized?.startsWith(`${rootPath}/`)
      ? normalized.slice(rootPath.length + 1)
      : null;
    const syncSelection = () => {
      syncingSelection.current = true;
      try {
        for (const selected of model.getSelectedPaths()) {
          if (selected !== path) model.getItem(selected)?.deselect();
        }
        const item = path ? model.getItem(path) : null;
        if (item && !item.isSelected()) item.select();
      } finally {
        syncingSelection.current = false;
      }
    };
    syncSelection();
    return model.onMutation('*', syncSelection);
  }, [model, rootPath, selectedPath]);

  return (
    <div className="ema-files-tree">
      <div className="ema-files-tree-search">
        <Input
          inputSize="sm"
          mono={false}
          value={filter}
          onChange={event => setFilter(event.target.value)}
          placeholder="筛选文件…"
          aria-label="筛选工作区文件"
          className="w-full rounded-lg"
          spellCheck={false}
        />
      </div>
      <div className="ema-files-tree-view">
        <FileTree
          model={model}
          style={{ height: '100%', minHeight: 0, width: '100%' }}
          aria-label="工作区文件树"
        />
      </div>
      {pendingCount > 0 && <p className="ema-files-tree-notice" role="status">正在读取目录…</p>}
      {Object.entries(errors).map(([path, message]) => (
        <div key={path} className="ema-files-tree-notice" role="alert">
          <span>{path || root}: {message}</span>
          <Button size="sm" variant="ghost" onClick={() => {
            directoryReads.current.delete(path);
            void loadDirectory(path);
          }}>重试</Button>
        </div>
      ))}
    </div>
  );
});
