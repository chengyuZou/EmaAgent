// 按 Session 与项目源文件夹隔离文件树与目录请求；无项目时浏览会话 cwd。
import { useState, useCallback, useEffect, useRef, type JSX, type CSSProperties } from 'react';
import { DropdownMenu, ScrollArea, type MenuItem } from '@ema-agent/ui';
import { ServerApiError } from '../../../../api/client.js';
import { filesApi, type FileEntry } from '../../../../api/workspaces.js';
import { useChatNavigationStore } from '../../../../stores/chatNavigation.js';
import { useSessionStore } from '../../../../stores/session.js';
import { fileTab, useSessionPanelStore } from '../../../../stores/sessionPanel.js';

function workspaceBrowserScopeKey(
  sessionId: string,
  roots: readonly string[],
): string {
  return JSON.stringify([sessionId, roots]);
}

// ── File icon by extension ────────────────────────────────────────────────────

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'i-mdi:language-typescript';
  if (['py'].includes(ext))                     return 'i-mdi:language-python';
  if (['rs'].includes(ext))                     return 'i-mdi:language-rust';
  if (['go'].includes(ext))                     return 'i-mdi:language-go';
  if (['md', 'mdx'].includes(ext))              return 'i-mdi:language-markdown';
  if (['json', 'jsonl', 'jsonc'].includes(ext)) return 'i-mdi:code-json';
  if (['yaml', 'yml'].includes(ext))            return 'i-mdi:file-code-outline';
  if (['css', 'scss', 'sass'].includes(ext))    return 'i-mdi:language-css3';
  if (['html', 'htm'].includes(ext))            return 'i-mdi:language-html5';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'i-mdi:image-outline';
  if (['pdf'].includes(ext))                    return 'i-mdi:file-pdf-box';
  if (['sh', 'bash', 'zsh', 'fish'].includes(ext)) return 'i-mdi:console';
  if (['toml', 'ini', 'cfg', 'conf'].includes(ext)) return 'i-mdi:file-cog-outline';
  if (['lock'].includes(ext) || name.endsWith('.lock')) return 'i-mdi:lock-outline';
  return 'i-mdi:file-outline';
}

function fmtSize(bytes: number): string {
  if (bytes < 1024)       return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

// ── Tree node ─────────────────────────────────────────────────────────────────

interface DirNode {
  children: FileEntry[] | null; // null = not loaded yet
  loading:  boolean;
  error:    string | null;
}

function directoryError(cause: unknown): string {
  if (cause instanceof ServerApiError) {
    if (cause.code === 'path_not_found') return '目录不存在';
    if (cause.code === 'access_denied') return '没有读取权限';
    if (cause.code === 'not_a_directory') return '所选路径不是目录';
  }
  return cause instanceof Error ? cause.message : '读取失败';
}

function FileRow({
  entry, depth, filter,
  dirNode, onToggle, onSelectFile, activeTabId,
}: {
  entry:        FileEntry;
  depth:        number;
  filter:       string;
  dirNode:      DirNode | undefined;
  onToggle:     (path: string) => void;
  onSelectFile: (path: string) => void;
  activeTabId?: string;
}): JSX.Element | null {
  const isDir    = entry.type === 'dir';
  const expanded = isDir && dirNode?.children != null;
  const loading  = isDir && dirNode?.loading;

  // Name-based filter: hide files that don't match when a filter is active.
  // Directories are always shown (their children will be filtered recursively).
  if (filter && !isDir && !entry.name.toLowerCase().includes(filter)) return null;

  const indent = depth * 14;

  const handleClick = (): void => {
    if (isDir) { onToggle(entry.path); return; }
    onSelectFile(entry.path);  // 工作区标签内预览,不走 OS
  };

  return (
    <div
      data-selected={!isDir && activeTabId === fileTab(entry.path).id ? true : undefined}
      className={`flex items-center gap-1.5 px-2 py-0.5 rounded cursor-pointer group select-none transition-colors ${
        !isDir && activeTabId === fileTab(entry.path).id
          ? 'bg-[var(--ema-primary-muted)]'
          : 'hover:bg-[var(--ema-surface-2)]'
      }`}
      style={{ paddingLeft: 8 + indent }}
      onClick={handleClick}
      title={entry.path}
    >
      {/* Expand arrow / file icon */}
      {isDir ? (
        <span
          className={`text-xs shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''} ${loading ? 'animate-spin' : ''} text-[var(--ema-text-tertiary)]`}
        >
          {loading
            ? <span className="i-lucide:loader-circle text-sm" />
            : <span className="i-lucide:chevron-right text-sm" />}
        </span>
      ) : (
        <span className={`${fileIcon(entry.name)} text-sm shrink-0 text-[var(--ema-text-tertiary)]`} aria-hidden />
      )}

      {isDir && !loading && (
        <span className={`${expanded ? 'i-lucide:folder-open' : 'i-lucide:folder'} text-sm shrink-0 text-[var(--ema-warning)]`} aria-hidden />
      )}

      <span
        className="flex-1 truncate font-mono text-[11px] leading-tight text-[var(--ema-text-primary)]"
      >
        {entry.name}
      </span>

      {!isDir && entry.size != null && (
        <span className="text-[10px] shrink-0 opacity-0 group-hover:opacity-100 transition-opacity tabular-nums text-[var(--ema-text-tertiary)]">
          {fmtSize(entry.size)}
        </span>
      )}
    </div>
  );
}

// ── Recursive subtree ─────────────────────────────────────────────────────────

function DirSubtree({
  dirPath, depth, filter, dirNodes, onToggle, onSelectFile, activeTabId,
}: {
  dirPath:      string;
  depth:        number;
  filter:       string;
  dirNodes:     Map<string, DirNode>;
  onToggle:     (path: string) => void;
  onSelectFile: (path: string) => void;
  activeTabId?: string;
}): JSX.Element | null {
  const node = dirNodes.get(dirPath);
  if (node?.error) {
    return (
      <div className="flex items-center gap-2 px-3 py-1 text-[10px] text-[var(--ema-danger)]" style={{ paddingLeft: 8 + depth * 14 }}>
        <span>{node.error}</span>
        <button type="button" className="underline" onClick={() => onToggle(dirPath)}>重试</button>
      </div>
    );
  }
  if (!node?.children) return null;

  return (
    <>
      {node.children.map((child, i) => (
        <div key={child.path} className="ema-stagger-in-swift" style={{ '--stagger-i': i } as CSSProperties}>
          <FileRow
            entry={child}
            depth={depth}
            filter={filter}
            dirNode={dirNodes.get(child.path)}
            onToggle={onToggle}
            onSelectFile={onSelectFile}
            activeTabId={activeTabId}
          />
          {child.type === 'dir' && (dirNodes.get(child.path)?.children != null || dirNodes.get(child.path)?.error) && (
            <DirSubtree
              dirPath={child.path}
              depth={depth + 1}
              filter={filter}
              dirNodes={dirNodes}
              onToggle={onToggle}
              onSelectFile={onSelectFile}
              activeTabId={activeTabId}
            />
          )}
        </div>
      ))}
    </>
  );
}

// ── FilesPanel ────────────────────────────────────────────────────────────────

export function FilesPanel(): JSX.Element {
  const sessionId  = useChatNavigationStore((s) => s.viewedSessionId);
  const loading = useSessionStore((s) => s.loading);
  const session    = useSessionStore((s) =>
    sessionId ? s.sessions.byId.get(sessionId) : undefined,
  );
  const project = useSessionStore((state) => {
    if (!session?.projectId) return undefined;
    return [...state.sessions.pinnedProjects, ...state.sessions.projects]
      .find((item) => item.id === session.projectId);
  });
  if (session?.projectId && !project) {
    return (
      <div className="flex items-center justify-center px-4 py-10 text-xs text-[var(--ema-text-tertiary)]">
        {loading ? '正在读取项目…' : '项目不可用'}
      </div>
    );
  }
  const projectFolders = project?.folders ?? [];
  const roots = projectFolders.length > 0
    ? projectFolders.map(folder => folder.path)
    : session ? [session.cwd] : [];
  const primaryRoot = projectFolders.length > 0
    ? projectFolders.find(folder => folder.isPrimary)?.path ?? roots[0] ?? null
    : session?.cwd ?? null;

  if (!sessionId || roots.length === 0 || !primaryRoot) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 px-4 ema-fade-in">
        <span className="i-lucide:folder-x text-3xl opacity-20 text-[var(--ema-primary)]" aria-hidden />
        <p className="text-xs text-center text-[var(--ema-text-tertiary)]">
          尚未打开会话
        </p>
      </div>
    );
  }

  const scopeKey = workspaceBrowserScopeKey(sessionId, roots);
  return (
    <ScopedFilesPanel
      key={scopeKey}
      projectName={project?.name ?? null}
      roots={roots}
      primaryRoot={primaryRoot}
    />
  );
}

function ScopedFilesPanel({
  projectName,
  roots,
  primaryRoot,
}: {
  projectName: string | null;
  roots: readonly string[];
  primaryRoot: string;
}): JSX.Element {
  const [root, setRoot] = useState(primaryRoot);
  const [search,       setSearch]       = useState('');
  const [dirNodes,     setDirNodes]     = useState<Map<string, DirNode>>(new Map);
  const requestGenerations = useRef(new Map<string, number>());

  // 点击文件在工作区 Dock 中以 file:<path> 标签打开（同一路径复用同一标签）。
  const sessionId = useChatNavigationStore((s) => s.viewedSessionId);
  // 当前激活标签:文件行高亮"正在预览"的唯一数据源(fileTab(path).id 比对)。
  const activeTabId = useSessionPanelStore((state) =>
    sessionId ? state.layouts[sessionId]?.activeTabId : undefined,
  );
  const openTab = useSessionPanelStore((state) => state.openTab);
  const openFileTab = useCallback((path: string): void => {
    if (!sessionId) return;
    openTab(sessionId, fileTab(path));
  }, [sessionId, openTab]);

  const filter = search.trim().toLowerCase();
  const folderItems: MenuItem[] = roots.map(path => ({
    kind: 'item',
    label: roots.some(other => other !== path && folderName(other) === folderName(path))
      ? path
      : folderName(path),
    icon: path === root ? 'i-lucide:check' : 'i-lucide:folder',
    onSelect: () => {
      setRoot(path);
      setSearch('');
    },
  }));

  const loadDir = useCallback(async (dirPath: string): Promise<void> => {
    const generation = (requestGenerations.current.get(dirPath) ?? 0) + 1;
    requestGenerations.current.set(dirPath, generation);
    setDirNodes((prev) => {
      const next = new Map(prev);
      const existing = next.get(dirPath);
      next.set(dirPath, { children: existing?.children ?? null, loading: true, error: null });
      return next;
    });
    try {
      const { entries } = await filesApi.ls(dirPath);
      if (requestGenerations.current.get(dirPath) !== generation) return;
      setDirNodes((prev) => {
        const next = new Map(prev);
        next.set(dirPath, { children: entries, loading: false, error: null });
        return next;
      });
    } catch (cause) {
      if (requestGenerations.current.get(dirPath) !== generation) return;
      setDirNodes((prev) => {
        const next = new Map(prev);
        next.set(dirPath, { children: null, loading: false, error: directoryError(cause) });
        return next;
      });
    }
  }, []);

  const toggleDir = useCallback((dirPath: string): void => {
    setDirNodes((prev) => {
      const existing = prev.get(dirPath);
      if (existing?.children != null) {
        // Collapse: clear children
        const next = new Map(prev);
        next.set(dirPath, { ...existing, children: null });
        return next;
      }
      return prev; // will trigger load below via effect
    });
    // If not loaded, load it
    const node = dirNodes.get(dirPath);
    if (!node?.children) void loadDir(dirPath);
  }, [dirNodes, loadDir]);

  // 根目录默认展开:首次 mount 时 lazy load root 内容(不套一层文件夹)
  useEffect(() => {
    if (root && !dirNodes.has(root)) void loadDir(root);
  }, [root, dirNodes, loadDir]);

  return (
    <div className="flex flex-col h-full ema-fade-in">
      <div className="shrink-0 space-y-1.5 border-b border-[var(--ema-border)] px-2 py-1.5">
        <div
          className="flex min-w-0 items-center gap-2 rounded-md border border-[var(--ema-border)] bg-[var(--ema-surface-2)] px-2 py-1 text-xs text-[var(--ema-text-primary)]"
          title={projectName ?? root}
        >
          <span className="i-lucide:folder shrink-0 text-sm" aria-hidden />
          <span className="truncate">{projectName ?? '执行目录'}</span>
        </div>
        {roots.length > 1 ? (
          <DropdownMenu
            side="bottom"
            align="start"
            widthClass="min-w-48 max-w-72"
            items={folderItems}
            trigger={(
              <button
                type="button"
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-[var(--ema-text-secondary)] transition-colors hover:bg-[var(--ema-surface-2)] hover:text-[var(--ema-text-primary)]"
                title={root}
                aria-label="选择项目源文件夹"
              >
                <span className="i-lucide:folder shrink-0 text-sm" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{folderName(root)}</span>
                <span className="i-lucide:chevron-down shrink-0 text-xs" aria-hidden />
              </button>
            )}
          />
        ) : (
          <div
            className="flex items-center gap-2 truncate px-1 text-xs text-[var(--ema-text-secondary)]"
            title={root}
          >
            <span className="i-lucide:folder text-sm" aria-hidden />
            <span className="truncate">{folderName(root)}</span>
          </div>
        )}
      </div>
      {/* Search */}
      <div className="px-2 py-1.5 border-b shrink-0 border-[var(--ema-border)]">
        <input
          className="w-full rounded-md px-2 py-1 text-[11px] outline-none bg-[var(--ema-surface-0)] text-[var(--ema-text-primary)] border border-[var(--ema-border)] shadow-[var(--ema-shadow-inset)] focus:border-[var(--ema-control-border-focus)] focus:shadow-[var(--ema-control-shadow-focus)]"
          placeholder="筛选文件…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          spellCheck={false}
        />
      </div>

      <ScrollArea orientation="both" className="flex-1" viewportClassName="py-1">
        {/* 根目录内容直接列(不套一层),depth=0 */}
        <DirSubtree
          dirPath={root}
          depth={0}
          filter={filter}
          dirNodes={dirNodes}
          onToggle={toggleDir}
          onSelectFile={openFileTab}
          activeTabId={activeTabId}
        />
        {dirNodes.get(root)?.loading && (
          <div className="px-3 py-1 text-[10px] text-[var(--ema-text-tertiary)]">加载中…</div>
        )}
      </ScrollArea>
    </div>
  );
}
