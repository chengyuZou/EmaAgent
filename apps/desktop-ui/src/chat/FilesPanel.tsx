/**
 * FilesPanel — workspace file browser for the Inspector dock.
 *
 * Roots = session.workspaceRoots (set via settings or Tauri file dialog).
 * Each root starts collapsed; clicking expands it lazily via
 * GET /api/workspace/ls?path=... Files are read-only (⌘-click opens in OS).
 * The search box filters by name (case-insensitive substring).
 */
import { useState, useCallback, useMemo, type JSX } from 'react';
import { ScrollArea } from '@ema-agent/ui';
import { workspaceApi, type FileEntry } from '../api/workspace.js';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore } from '../stores/session-store.js';
import { tauriBridge } from '../lib/tauri-bridge.js';

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

// ── Tree node ─────────────────────────────────────────────────────────────────

interface DirNode {
  path:     string;
  children: FileEntry[] | null; // null = not loaded yet
  loading:  boolean;
  error:    boolean;
}

function FileRow({
  entry, depth, filter,
  dirNode, onToggle,
}: {
  entry:    FileEntry;
  depth:    number;
  filter:   string;
  dirNode:  DirNode | undefined;
  onToggle: (path: string) => void;
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
    void tauriBridge.openPath(entry.path).catch(() => {});
  };

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-0.5 rounded cursor-pointer group select-none hover:bg-neutral-800/50 transition-colors"
      style={{ paddingLeft: 8 + indent }}
      onClick={handleClick}
      title={entry.path}
    >
      {/* Expand arrow / file icon */}
      {isDir ? (
        <span
          className={`text-xs shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''} ${loading ? 'animate-spin' : ''}`}
          style={{ color: 'var(--ema-text-tertiary)' }}
        >
          {loading
            ? <span className="i-mdi:loading text-sm" />
            : <span className="i-mdi:chevron-right text-sm" />}
        </span>
      ) : (
        <span className={`${fileIcon(entry.name)} text-sm shrink-0`}
              style={{ color: 'var(--ema-text-tertiary)' }} aria-hidden />
      )}

      {isDir && !loading && (
        <span className={`i-mdi:folder${expanded ? '-open' : ''}-outline text-sm shrink-0`}
              style={{ color: 'oklch(0.72 0.12 80)' }} aria-hidden />
      )}

      <span
        className="flex-1 truncate text-[11px] leading-tight"
        style={{ color: 'var(--ema-text-primary)' }}
      >
        {entry.name}
      </span>

      {!isDir && entry.size != null && (
        <span className="text-[10px] shrink-0 opacity-0 group-hover:opacity-100 transition-opacity tabular-nums"
              style={{ color: 'var(--ema-text-tertiary)' }}>
          {fmtSize(entry.size)}
        </span>
      )}
    </div>
  );
}

// ── Recursive subtree ─────────────────────────────────────────────────────────

function DirSubtree({
  dirPath, depth, filter, dirNodes, onToggle,
}: {
  dirPath:  string;
  depth:    number;
  filter:   string;
  dirNodes: Map<string, DirNode>;
  onToggle: (path: string) => void;
}): JSX.Element | null {
  const node = dirNodes.get(dirPath);
  if (!node?.children) return null;

  return (
    <>
      {node.children.map((child) => (
        <div key={child.path}>
          <FileRow
            entry={child}
            depth={depth}
            filter={filter}
            dirNode={dirNodes.get(child.path)}
            onToggle={onToggle}
          />
          {child.type === 'dir' && dirNodes.get(child.path)?.children != null && (
            <DirSubtree
              dirPath={child.path}
              depth={depth + 1}
              filter={filter}
              dirNodes={dirNodes}
              onToggle={onToggle}
            />
          )}
        </div>
      ))}
      {node.error && (
        <div className="px-3 py-0.5 text-[10px]" style={{ paddingLeft: 8 + depth * 14, color: 'var(--ema-danger)' }}>
          读取失败
        </div>
      )}
    </>
  );
}

// ── FilesPanel ────────────────────────────────────────────────────────────────

export function FilesPanel(): JSX.Element {
  const sessionId  = useConversationStore((s) => s.viewedSessionId);
  const session    = useSessionStore((s) =>
    sessionId ? s.sessions.byId.get(sessionId as string) : undefined,
  );

  const roots: string[] = session?.workspaceRoots ?? [];

  const [search,   setSearch]   = useState('');
  const [dirNodes, setDirNodes] = useState<Map<string, DirNode>>(new Map);

  const filter = search.trim().toLowerCase();

  const loadDir = useCallback(async (dirPath: string): Promise<void> => {
    setDirNodes((prev) => {
      const next = new Map(prev);
      const existing = next.get(dirPath);
      next.set(dirPath, { path: dirPath, children: existing?.children ?? null, loading: true, error: false });
      return next;
    });
    try {
      const entries = await workspaceApi.ls(dirPath);
      setDirNodes((prev) => {
        const next = new Map(prev);
        next.set(dirPath, { path: dirPath, children: entries, loading: false, error: false });
        return next;
      });
    } catch {
      setDirNodes((prev) => {
        const next = new Map(prev);
        next.set(dirPath, { path: dirPath, children: null, loading: false, error: true });
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

  // Roots rendered as top-level expandable entries
  const rootEntries: FileEntry[] = useMemo(
    () => roots.map((r) => ({ name: r.split(/[\\/]/).pop() ?? r, path: r, type: 'dir' as const })),
    [roots],
  );

  if (roots.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 px-4">
        <span className="i-mdi:folder-alert-outline text-3xl opacity-20"
              style={{ color: 'var(--ema-primary)' }} aria-hidden />
        <p className="text-xs text-center" style={{ color: 'var(--ema-text-tertiary)' }}>
          当前会话未配置工作区
        </p>
        <p className="text-[10px] text-center opacity-50" style={{ color: 'var(--ema-text-tertiary)' }}>
          在设置 → 工作区中添加目录
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="px-2 py-1.5 border-b shrink-0" style={{ borderColor: 'var(--ema-border)' }}>
        <input
          className="w-full bg-neutral-800/60 rounded-md px-2 py-1 text-[11px] outline-none placeholder-neutral-600"
          style={{ color: 'var(--ema-text-primary)' }}
          placeholder="筛选文件…（? 前缀搜索内容）"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          spellCheck={false}
        />
      </div>

      <ScrollArea orientation="vertical" className="flex-1" viewportClassName="py-1">
        {rootEntries.map((root) => (
          <div key={root.path}>
            <FileRow
              entry={root}
              depth={0}
              filter={filter}
              dirNode={dirNodes.get(root.path)}
              onToggle={toggleDir}
            />
            <DirSubtree
              dirPath={root.path}
              depth={1}
              filter={filter}
              dirNodes={dirNodes}
              onToggle={toggleDir}
            />
          </div>
        ))}
      </ScrollArea>
    </div>
  );
}
