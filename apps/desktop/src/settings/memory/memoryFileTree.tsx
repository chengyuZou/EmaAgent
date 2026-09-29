// Memory API 只列一层目录; 按展开加载分页, 树模型和滚动复用官方 Trees 与共享 patch.
import { memo, useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { Button, EmptyState, Input } from '@ema-agent/ui';
import { memoryApi } from '../../api/memory.js';
import treeCSS from '../../styles/vendors/fileTree.css?inline';

type DirectoryRead =
  | { state: 'loading'; paths: readonly string[]; controller: AbortController }
  | { state: 'loaded'; paths: readonly string[] }
  | { state: 'failed'; paths: readonly string[] };

interface MemoryFileTreeProps {
  selectedPath: string | null;
  refreshVersion: number;
  onOpen: (path: string) => void;
}

export const MemoryFileTree = memo(function MemoryFileTree({
  selectedPath,
  refreshVersion,
  onOpen,
}: MemoryFileTreeProps): JSX.Element {
  const [filter, setFilter] = useState('');
  const [pendingCount, setPendingCount] = useState(0);
  const [rootEmpty, setRootEmpty] = useState(false);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const directoryReads = useRef(new Map<string, DirectoryRead>());
  const syncingSelection = useRef(false);
  const open = useCallback((paths: readonly string[]) => {
    if (syncingSelection.current) return;
    const path = paths.at(-1);
    if (path && model.getItem(path)?.isDirectory() === false) onOpen(path);
  }, [onOpen]);
  const { model } = useFileTree({
    paths: [],
    density: 'compact',
    icons: 'complete',
    initialExpansion: 'closed',
    flattenEmptyDirectories: false,
    stickyFolders: false,
    search: false,
    fileTreeSearchMode: 'hide-non-matches',
    onSelectionChange: open,
    unsafeCSS: treeCSS,
  });

  const loadDirectory = useCallback(async (path: string, refresh = false): Promise<void> => {
    const previous = directoryReads.current.get(path);
    if (previous && (!refresh || previous.state === 'loading')) return;
    const controller = new AbortController();
    const previousPaths = previous?.paths ?? [];
    directoryReads.current.set(path, { state: 'loading', paths: previousPaths, controller });
    setPendingCount(value => value + 1);

    try {
      const paths: string[] = [];
      let cursor: string | undefined;
      do {
        const result = await memoryApi.listFiles({
          path: path || undefined,
          cursor,
        }, controller.signal);
        if (controller.signal.aborted) return;
        for (const entry of result.entries) {
          paths.push(entry.entryType === 'directory' ? `${entry.path}/` : entry.path);
        }
        cursor = result.nextCursor;
      } while (cursor);

      const oldPaths = new Set(previousPaths);
      const newPaths = new Set(paths);
      directoryReads.current.set(path, { state: 'loaded', paths });
      // 局部增删保留未变化目录的展开、选择和滚动, 不 reset 整棵树.
      model.batch([
        ...previousPaths.filter(item => !newPaths.has(item)).map(item => ({
          type: 'remove' as const,
          path: item,
          recursive: true,
        })),
        ...paths.filter(item => !oldPaths.has(item)).map(item => ({
          type: 'add' as const,
          path: item,
        })),
      ]);
      for (const removed of previousPaths) {
        if (!removed.endsWith('/') || newPaths.has(removed)) continue;
        for (const [directory, read] of directoryReads.current) {
          if (!directory.startsWith(removed)) continue;
          if (read.state === 'loading') {
            read.controller.abort();
            setPendingCount(value => value - 1);
          }
          directoryReads.current.delete(directory);
        }
      }
      if (!path) setRootEmpty(paths.length === 0);
      setErrors(current => {
        const next = { ...current };
        delete next[path];
        for (const directory of Object.keys(next)) {
          if (directory && !model.getItem(directory)) delete next[directory];
        }
        return next;
      });
    } catch (cause) {
      if (controller.signal.aborted) return;
      directoryReads.current.set(path, { state: 'failed', paths: previousPaths });
      const message = cause instanceof Error ? cause.message : '读取目录失败';
      setErrors(current => ({ ...current, [path]: message }));
    } finally {
      if (!controller.signal.aborted) setPendingCount(value => value - 1);
    }
  }, [model]);

  useEffect(() => {
    const unsubscribe = model.subscribe(() => {
      for (const row of model.getVisibleRows(0, model.getVisibleCount())) {
        if (row.kind === 'directory' && row.isExpanded) void loadDirectory(row.path);
      }
    });
    let disposed = false;
    const directories = [...directoryReads.current.keys()]
      .filter(path => path !== '')
      .sort((left, right) => left.split('/').length - right.split('/').length);

    void (async () => {
      await loadDirectory('', true);
      // 先刷新父目录, 再刷新已读过且仍存在的子目录; 不重新遍历整份 Memory.
      for (const directory of directories) {
        if (disposed) return;
        if (model.getItem(directory)?.isDirectory()) await loadDirectory(directory, true);
      }
    })();

    return () => {
      disposed = true;
      unsubscribe();
      for (const [path, read] of directoryReads.current) {
        if (read.state !== 'loading') continue;
        read.controller.abort();
        directoryReads.current.set(path, { state: 'failed', paths: read.paths });
      }
      setPendingCount(0);
    };
  }, [model, loadDirectory, refreshVersion]);

  useEffect(() => model.setSearch(filter || null), [model, filter]);

  useEffect(() => {
    const syncSelection = () => {
      syncingSelection.current = true;
      try {
        for (const path of model.getSelectedPaths()) {
          if (path !== selectedPath) model.getItem(path)?.deselect();
        }
        const item = selectedPath ? model.getItem(selectedPath) : null;
        if (item && !item.isSelected()) item.select();
      } finally {
        syncingSelection.current = false;
      }
    };
    syncSelection();
    return model.onMutation('*', syncSelection);
  }, [model, selectedPath]);

  return (
    <div className="ema-memory-tree">
      <div className="ema-memory-tree-filter">
        <Input
          inputSize="sm"
          mono={false}
          value={filter}
          onChange={event => setFilter(event.target.value)}
          placeholder="筛选已加载文件…"
          aria-label="筛选已加载的 Memory 文件"
          spellCheck={false}
        />
      </div>
      <div className="ema-memory-tree-view">
        <FileTree
          model={model}
          style={{ height: '100%', minHeight: 0, width: '100%' }}
          aria-label="Memory 文件树"
        />
        {rootEmpty && <EmptyState size="sm" title="暂无 Memory 文件" className="ema-memory-tree-empty" />}
      </div>
      {pendingCount > 0 && <p className="ema-memory-tree-notice" role="status">正在读取目录…</p>}
      {Object.entries(errors).map(([path, message]) => (
        <div key={path} className="ema-memory-tree-notice" role="alert">
          <span>{path || 'Memory'}: {message}</span>
          <Button size="sm" variant="ghost" onClick={() => void loadDirectory(path, true)}>重试</Button>
        </div>
      ))}
    </div>
  );
});
