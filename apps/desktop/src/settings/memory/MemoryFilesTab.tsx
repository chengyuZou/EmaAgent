import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { Button, Callout, IconButton, SearchField, Spinner } from '@ema-agent/ui';
import { memoryApi, type MemoryFileContent, type MemorySearchResult } from '../../api/memory.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { Markdown } from '../../markdown/renderer.js';

type MemoryTrack = 'work' | 'relationship';

interface TreeNode {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly kind: 'directory' | 'file';
}

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

  const grouped = useMemo(() => ({
    work: buildTrackTree(files, 'work'),
    relationship: buildTrackTree(files, 'relationship'),
  }), [files]);

  const showingSearch = searchResult !== null && query.trim().length > 0;

  return (
    <div className="flex h-full min-h-[38rem] min-w-0 flex-1 flex-col gap-3">
      <div className="shrink-0">
        <div className="mb-2">
          <h3 className="text-sm font-semibold text-[var(--ema-text-primary)]">Memory 文件</h3>
          <p className="mt-0.5 text-xs text-[var(--ema-text-tertiary)]">
            浏览、搜索并阅读 Memory 文件内容。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            className="min-w-[18rem] flex-1"
            value={query}
            placeholder="搜索 Memory 正文"
            aria-label="搜索 Memory 正文"
            loading={searching}
            onChange={value => {
              setQuery(value);
              setSearchResult(null);
            }}
            onSubmit={() => void search()}
          />

          <Button
            variant="ghost"
            size="sm"
            icon="i-lucide:refresh-cw"
            loading={loadingTree}
            onClick={() => void loadTree()}
          >
            刷新
          </Button>
        </div>
      </div>

      {error && <Callout variant="danger">{error}</Callout>}

      <div
        className={`grid min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] shadow-[var(--ema-shadow-soft)] transition-[grid-template-columns] duration-200 ${
          treeOpen
            ? 'grid-cols-[18rem_minmax(0,1fr)]'
            : 'grid-cols-[3.25rem_minmax(0,1fr)]'
        }`}
      >
        <aside className="min-h-0 border-r border-[var(--ema-border)] bg-[var(--ema-surface-1)]">
          {treeOpen ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--ema-border)] px-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--ema-text-primary)]">
                    {showingSearch ? '搜索结果' : '文件目录'}
                  </p>
                  <p className="text-[11px] text-[var(--ema-text-tertiary)]">
                    {showingSearch
                      ? `共 ${searchResult?.matches.length ?? 0} 条结果${searchResult?.truncated ? '（已截断）' : ''}`
                      : `${files.length} 个文件`}
                  </p>
                </div>

                <IconButton
                  size="sm"
                  icon="i-lucide:panel-left-close"
                  label="折叠文件列表"
                  className="size-7 shrink-0"
                  onClick={() => setTreeOpen(false)}
                />
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {loadingTree ? (
                  <div className="flex justify-center py-10">
                    <Spinner size="sm" />
                  </div>
                ) : showingSearch ? (
                  <SearchResults
                    result={searchResult}
                    selected={selected}
                    onOpen={filePath => void openFile(filePath)}
                  />
                ) : (
                  <div className="space-y-4">
                    <TreeSection
                      title="Work"
                      nodes={grouped.work}
                      selected={selected}
                      onOpen={filePath => void openFile(filePath)}
                    />
                    <TreeSection
                      title="Relationship"
                      nodes={grouped.relationship}
                      selected={selected}
                      onOpen={filePath => void openFile(filePath)}
                    />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center border-r-0">
              <div className="flex h-12 w-full items-center justify-center border-b border-[var(--ema-border)]">
                <IconButton
                  size="sm"
                  icon="i-lucide:panel-left-open"
                  label="展开文件列表"
                  className="size-7"
                  onClick={() => setTreeOpen(true)}
                />
              </div>

              <div className="flex flex-1 items-start justify-center pt-3">
                <span
                  className="i-lucide:files text-lg text-[var(--ema-text-tertiary)] opacity-70"
                  aria-hidden
                />
              </div>
            </div>
          )}
        </aside>

        <main className="flex min-h-0 min-w-0 flex-col bg-[var(--ema-surface-1)]">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--ema-border)] px-4">
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs text-[var(--ema-text-secondary)]">
                {selected ?? '请选择一份 Memory 文件'}
              </p>
            </div>

            {document && (
              <Button
                variant="secondary"
                size="sm"
                icon="i-lucide:folder-search-2"
                onClick={() => void tauriBridge.revealInFolder(document.absolutePath)
                  .catch(reason => setError(errorMessage(reason, '在文件管理器中定位失败')))}
              >
                打开所在文件夹
              </Button>
            )}
          </div>

          {selected === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6">
              <div className="flex max-w-sm flex-col items-center gap-3 text-center">
                <div className="flex size-14 items-center justify-center rounded-2xl bg-[var(--ema-surface-2)]">
                  <span className="i-lucide:file-search-2 text-2xl text-[var(--ema-text-tertiary)] opacity-70" aria-hidden />
                </div>
                <div>
                  <p className="text-sm font-medium text-[var(--ema-text-secondary)]">还没有打开任何文件</p>
                  <p className="mt-1 text-xs text-[var(--ema-text-tertiary)]">
                    从左侧选择文件，或先在上方搜索 Memory 内容。
                  </p>
                </div>
              </div>
            </div>
          ) : document === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <Spinner size="sm" />
            </div>
          ) : (
            <>
              {document.truncated && (
                <Callout variant="info">
                  文件较大，这里只展示开头部分；如需完整内容，可打开所在文件夹查看。
                </Callout>
              )}

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">
                <div className="mx-auto w-full max-w-4xl">
                  <Markdown source={document.content} />
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function TreeSection(props: {
  title: string;
  nodes: readonly TreeNode[];
  selected: string | null;
  onOpen: (path: string) => void;
}): JSX.Element {
  return (
    <section>
      <div className="mb-1 px-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ema-text-tertiary)]">
          {props.title}
        </p>
      </div>

      {props.nodes.length === 0 ? (
        <p className="px-2 py-2 text-[11px] text-[var(--ema-text-tertiary)]">暂无文件</p>
      ) : (
        <div className="space-y-0.5">
          {props.nodes.map(node => (
            node.kind === 'directory' ? (
              <div
                key={`directory:${node.path}`}
                className="flex h-8 items-center gap-1.5 rounded-lg pr-3 text-xs text-[var(--ema-text-tertiary)]"
                style={{ paddingLeft: `${10 + node.depth * 14}px` }}
              >
                <span className="i-lucide:chevron-down shrink-0 text-[10px] opacity-60" aria-hidden />
                <span className="i-lucide:folder shrink-0 opacity-70" aria-hidden />
                <span className="truncate">{node.name}</span>
              </div>
            ) : (
              <button
                key={node.path}
                type="button"
                className={`flex h-9 w-full items-center gap-1.5 rounded-xl pr-3 text-left text-xs transition-colors ${
                  props.selected === node.path
                    ? 'bg-[var(--ema-primary-muted)] text-[var(--ema-primary-text)]'
                    : 'text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)]'
                }`}
                style={{ paddingLeft: `${10 + node.depth * 14}px` }}
                onClick={() => props.onOpen(node.path)}
              >
                <span className="i-lucide:file-text shrink-0 opacity-70" aria-hidden />
                <span className="truncate">{node.name}</span>
              </button>
            )
          ))}
        </div>
      )}
    </section>
  );
}

function SearchResults(props: {
  result: MemorySearchResult;
  selected: string | null;
  onOpen: (path: string) => void;
}): JSX.Element {
  if (props.result.matches.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
        <span className="i-lucide:search-x mb-2 text-xl text-[var(--ema-text-tertiary)] opacity-70" aria-hidden />
        <p className="text-xs text-[var(--ema-text-tertiary)]">没有找到相关内容。</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {props.result.matches.map((match, index) => {
        const active = props.selected === match.path;
        return (
          <button
            key={`${match.path}:${match.matchLineNumber}:${index}`}
            type="button"
            className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
              active
                ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
                : 'border-transparent bg-[var(--ema-surface-1)] hover:border-[var(--ema-border)] hover:bg-[var(--ema-surface-2)]'
            }`}
            onClick={() => props.onOpen(match.path)}
          >
            <p className="truncate text-xs font-semibold text-[var(--ema-text-secondary)]">
              {match.path}
            </p>
            <p className="mt-1 text-[11px] text-[var(--ema-text-tertiary)]">
              第 {match.matchLineNumber} 行
            </p>
            <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11px] text-[var(--ema-text-secondary)]">
              {match.content}
            </p>
          </button>
        );
      })}
    </div>
  );
}

function buildTrackTree(files: readonly string[], track: MemoryTrack): TreeNode[] {
  const prefix = `${track}/`;
  const directories = new Map<string, TreeNode>();
  const result: TreeNode[] = [];

  for (const filePath of files) {
    if (!filePath.startsWith(prefix)) continue;

    const relativePath = filePath.slice(prefix.length);
    const segments = relativePath.split('/').filter(Boolean);

    for (let index = 0; index < segments.length - 1; index += 1) {
      const directoryPath = `${track}/${segments.slice(0, index + 1).join('/')}`;

      if (!directories.has(directoryPath)) {
        directories.set(directoryPath, {
          path: directoryPath,
          name: segments[index] ?? directoryPath,
          depth: index,
          kind: 'directory',
        });
      }
    }

    result.push({
      path: filePath,
      name: segments.at(-1) ?? filePath,
      depth: Math.max(0, segments.length - 1),
      kind: 'file',
    });
  }

  result.push(...directories.values());

  return result.sort((left, right) => {
    const leftSegments = left.path.split('/');
    const rightSegments = right.path.split('/');
    const commonLength = Math.min(leftSegments.length, rightSegments.length);

    for (let index = 0; index < commonLength; index += 1) {
      const leftPart = leftSegments[index] ?? '';
      const rightPart = rightSegments[index] ?? '';
      if (leftPart !== rightPart) return leftPart.localeCompare(rightPart);
    }

    if (leftSegments.length !== rightSegments.length) {
      return leftSegments.length - rightSegments.length;
    }

    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}