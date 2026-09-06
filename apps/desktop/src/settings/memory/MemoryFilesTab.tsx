import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { Button, Callout, IconButton, Input, Spinner } from '@ema-agent/ui';
import { memoryApi, type MemoryFileContent, type MemorySearchResult } from '../../api/memory.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { Markdown } from '../../markdown/renderer.js';

export function MemoryFilesTab(): JSX.Element {
  const [treeOpen, setTreeOpen] = useState(true);
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [document, setDocument] = useState<MemoryFileContent | null>(null);
  const [query, setQuery] = useState('');
  const [searchResult, setSearchResult] = useState<MemorySearchResult | null>(null);
  const [loadingTree, setLoadingTree] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTree = useCallback(async (): Promise<void> => {
    setLoadingTree(true);
    try {
      const collected: string[] = [];
      const directories: (string | undefined)[] = [undefined];
      while (directories.length > 0) {
        const directory = directories.shift();
        let cursor: string | undefined;
        do {
          const result = await memoryApi.listFiles({
            ...(directory ? { path: directory } : {}),
            ...(cursor ? { cursor } : {}),
          });
          for (const entry of result.entries) {
            if (entry.entryType === 'directory') directories.push(entry.path);
            else collected.push(entry.path);
          }
          cursor = result.nextCursor;
        } while (cursor);
      }
      setFiles(collected.sort());
      setError(null);
    } catch (reason) {
      setError(errorMessage(reason, '读取 Memory 文件列表失败'));
    } finally {
      setLoadingTree(false);
    }
  }, []);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  async function openFile(filePath: string): Promise<void> {
    setSelected(filePath);
    setDocument(null);
    try {
      setDocument(await memoryApi.readFile({ path: filePath }));
      setError(null);
    } catch (reason) {
      setSelected(null);
      setError(errorMessage(reason, '读取 Memory 文件失败'));
    }
  }

  async function search(): Promise<void> {
    const value = query.trim();
    if (!value) {
      setSearchResult(null);
      return;
    }
    setSearching(true);
    try {
      setSearchResult(await memoryApi.search({
        queries: [value],
        caseSensitive: false,
        normalized: true,
        contextLines: 1,
        maxResults: 100,
      }));
      setError(null);
    } catch (reason) {
      setError(errorMessage(reason, '搜索 Memory 失败'));
    } finally {
      setSearching(false);
    }
  }

  const grouped = useMemo(() => groupByTrack(files), [files]);
  const showingSearch = searchResult !== null && query.trim().length > 0;

  return (
    <div className="flex min-h-[34rem] flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input
          className="min-w-0 flex-1"
          value={query}
          placeholder="搜索 Memory 正文"
          aria-label="搜索 Memory 正文"
          onChange={event => {
            setQuery(event.target.value);
            setSearchResult(null);
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') void search();
          }}
        />
        <Button variant="secondary" size="sm" loading={searching} onClick={() => void search()}>
          搜索
        </Button>
        <Button variant="ghost" size="sm" icon="i-lucide:refresh-cw" onClick={() => void loadTree()}>
          刷新
        </Button>
      </div>

      {error && <Callout variant="danger">{error}</Callout>}

      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] ema-glass-weak">
        <aside className={`shrink-0 overflow-hidden border-r border-[var(--ema-border)] transition-[width] ${treeOpen ? 'w-64' : 'w-0 border-r-0'}`}>
          <div className="h-full overflow-y-auto py-2">
            {loadingTree ? (
              <div className="flex justify-center py-10"><Spinner size="sm" /></div>
            ) : showingSearch ? (
              <SearchResults result={searchResult} onOpen={filePath => void openFile(filePath)} />
            ) : (
              (['work', 'relationship'] as const).map(track => (
                <div key={track} className="mb-3">
                  <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--ema-text-tertiary)]">
                    {track === 'work' ? 'Work' : 'Relationship'}
                  </p>
                  {grouped[track].map(file => (
                    <button
                      key={file.path}
                      type="button"
                      className={`flex w-full items-center gap-1.5 py-1.5 pr-3 text-left text-xs transition-colors ${
                        selected === file.path
                          ? 'bg-[var(--ema-primary-muted)] text-[var(--ema-primary-text)]'
                          : 'text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)]'
                      }`}
                      style={{ paddingLeft: `${12 + file.depth * 12}px` }}
                      onClick={() => void openFile(file.path)}
                    >
                      <span className="i-lucide:file-text shrink-0 opacity-60" aria-hidden />
                      <span className="truncate">{file.name}</span>
                    </button>
                  ))}
                  {grouped[track].length === 0 && (
                    <p className="px-3 py-2 text-[11px] text-[var(--ema-text-tertiary)]">暂无文件</p>
                  )}
                </div>
              ))
            )}
          </div>
        </aside>

        <div className="relative shrink-0">
          <IconButton
            size="sm"
            icon={treeOpen ? 'i-lucide:panel-left-close' : 'i-lucide:panel-left-open'}
            label={treeOpen ? '折叠文件列表' : '展开文件列表'}
            className="absolute -left-3 top-2 z-10 size-6 rounded-full border border-[var(--ema-border)] bg-[var(--ema-surface-3)]"
            onClick={() => setTreeOpen(open => !open)}
          />
        </div>

        <main className="flex min-w-0 flex-1 flex-col">
          {selected === null ? (
            <div className="flex flex-1 items-center justify-center text-xs text-[var(--ema-text-tertiary)]">
              从左侧选择一份 Memory 文件。
            </div>
          ) : document === null ? (
            <div className="flex flex-1 items-center justify-center"><Spinner size="sm" /></div>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-[var(--ema-border)] px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--ema-text-secondary)]">{selected}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  icon="i-lucide:folder-search-2"
                  onClick={() => void tauriBridge.revealInFolder(document.absolutePath)
                    .catch(reason => setError(errorMessage(reason, '在文件管理器中定位失败')))}
                >
                  打开所在文件夹
                </Button>
              </div>
              {document.truncated && (
                <Callout variant="info">
                  文件较大，这里只展示开头部分；可打开所在文件夹查看完整内容。
                </Callout>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <Markdown source={document.content} />
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function SearchResults(props: {
  result: MemorySearchResult;
  onOpen: (path: string) => void;
}): JSX.Element {
  if (props.result.matches.length === 0) {
    return <p className="px-3 py-8 text-center text-xs text-[var(--ema-text-tertiary)]">没有找到相关内容。</p>;
  }
  return (
    <div className="flex flex-col gap-1 px-2">
      <p className="px-1 py-1 text-[10px] text-[var(--ema-text-tertiary)]">
        {props.result.matches.length} 条结果{props.result.truncated ? '，仅显示前 100 条' : ''}
      </p>
      {props.result.matches.map((match, index) => (
        <button
          key={`${match.path}:${match.matchLineNumber}:${index}`}
          type="button"
          className="rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--ema-surface-2)]"
          onClick={() => props.onOpen(match.path)}
        >
          <p className="truncate text-xs font-semibold text-[var(--ema-text-secondary)]">{match.path}</p>
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11px] text-[var(--ema-text-tertiary)]">
            第 {match.matchLineNumber} 行 · {match.content}
          </p>
        </button>
      ))}
    </div>
  );
}

interface TreeFile {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
}

function groupByTrack(files: readonly string[]): { work: TreeFile[]; relationship: TreeFile[] } {
  const work: TreeFile[] = [];
  const relationship: TreeFile[] = [];
  for (const filePath of files) {
    const segments = filePath.split('/');
    const entry = {
      path: filePath,
      name: segments.at(-1) ?? filePath,
      depth: Math.max(0, segments.length - 2),
    };
    if (filePath.startsWith('work/')) work.push(entry);
    if (filePath.startsWith('relationship/')) relationship.push(entry);
  }
  return { work, relationship };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
