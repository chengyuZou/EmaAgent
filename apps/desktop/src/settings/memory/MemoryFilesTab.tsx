// 正文搜索与只读预览由 Memory API 提供; 目录浏览交给官方 Trees, 不接入 Session 标签状态.
import { memo, useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Button, Callout, EmptyState, IconButton, Markdown, SearchField, Spinner, Tooltip } from '@ema-agent/ui';
import { memoryApi, type MemoryFileContent, type MemorySearchResult } from '../../api/memory.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { PageHeader } from '../shared/PageHeader.js';
import { MemoryFileTree } from './memoryFileTree.js';

type MemoryRead =
  | { state: 'loading'; path: string }
  | { state: 'ready'; path: string; document: MemoryFileContent }
  | { state: 'failed'; path: string; message: string };

export function MemoryFilesTab(): JSX.Element {
  const [treeOpen, setTreeOpen] = useState(true);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [read, setRead] = useState<MemoryRead | null>(null);
  const [query, setQuery] = useState('');
  const [searchResult, setSearchResult] = useState<MemorySearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const readRequest = useRef<AbortController | null>(null);
  const searchRequest = useRef<AbortController | null>(null);

  const openFile = useCallback(async (path: string): Promise<void> => {
    readRequest.current?.abort();
    const controller = new AbortController();
    readRequest.current = controller;
    setRead({ state: 'loading', path });
    try {
      const document = await memoryApi.readFile({ path }, controller.signal);
      if (!controller.signal.aborted) setRead({ state: 'ready', path, document });
    } catch (cause) {
      if (!controller.signal.aborted) {
        setRead({ state: 'failed', path, message: errorMessage(cause, '读取 Memory 文件失败') });
      }
    }
  }, []);

  const search = useCallback(async (): Promise<void> => {
    searchRequest.current?.abort();
    const value = query.trim();
    if (!value) {
      setSearchResult(null);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    searchRequest.current = controller;
    setSearching(true);
    setSearchError(null);
    try {
      const result = await memoryApi.search({
        queries: [value],
        caseSensitive: false,
        normalized: true,
        contextLines: 1,
        maxResults: 100,
      }, controller.signal);
      if (!controller.signal.aborted) setSearchResult(result);
    } catch (cause) {
      if (!controller.signal.aborted) setSearchError(errorMessage(cause, '搜索 Memory 失败'));
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }, [query]);

  const changeQuery = useCallback((value: string) => {
    searchRequest.current?.abort();
    setQuery(value);
    setSearchResult(null);
    setSearching(false);
    setSearchError(null);
  }, []);
  const toggleTree = useCallback(() => setTreeOpen(value => !value), []);
  const refresh = useCallback(() => {
    setRefreshVersion(value => value + 1);
    if (read) void openFile(read.path);
    if (searchResult) void search();
  }, [read, openFile, searchResult, search]);

  useEffect(() => () => {
    readRequest.current?.abort();
    searchRequest.current?.abort();
  }, []);

  const showingSearch = searchResult !== null;

  return (
    <div className="ema-memory-files">
      <PageHeader title="Memory 文件" description="浏览、搜索并阅读 Memory 文件内容" />
      
      {searchError && <Callout variant="danger">{searchError}</Callout>}

      <section className="ema-memory-browser" aria-label="Memory 文件浏览器">
        <div className="ema-memory-browser-header">
          <span className="ema-memory-location" title={read?.path}>
            {read?.path ?? '请选择一份 Memory 文件'}
          </span>
          <Tooltip content={treeOpen ? '隐藏文件列表' : '显示文件列表'} side="bottom">
            <IconButton
              size="sm"
              variant="ghost"
              icon="i-review:reviewFiles"
              label={treeOpen ? '隐藏 Memory 文件列表' : '显示 Memory 文件列表'}
              toggled={treeOpen}
              aria-pressed={treeOpen}
              aria-controls="memory-file-list"
              onClick={toggleTree}
            />
          </Tooltip>
        </div>
        <div className="ema-memory-browser-body">
          <MemoryReader read={read} onOpen={openFile} />
          <aside
            id="memory-file-list"
            className="ema-memory-tree-pane ema-memory-explorer-bg"
            data-open={treeOpen}
            aria-label="Memory 文件列表"
            aria-hidden={!treeOpen}
            {...(treeOpen ? {} : { inert: '' })}
          >
            <div className="ema-memory-list-header">
              <span>{showingSearch ? '正文搜索结果' : 'Memory 目录'}</span>
              {searchResult && <span className="text-[var(--ema-text-tertiary)]">{searchResult.matches.length} 条</span>}
            </div>
            <div className={showingSearch ? 'hidden' : 'ema-memory-list-content'}>
              <MemoryFileTree
                selectedPath={read?.path ?? null}
                refreshVersion={refreshVersion}
                onOpen={openFile}
              />
            </div>
            {searchResult && (
              <MemorySearchResults result={searchResult} selectedPath={read?.path ?? null} onOpen={openFile} />
            )}
          </aside>
        </div>
      </section>
    </div>
  );
}

const MemoryReader = memo(function MemoryReader({ read, onOpen }: {
  read: MemoryRead | null;
  onOpen: (path: string) => void;
}): JSX.Element {
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => setActionError(null), [read?.path]);

  let content: JSX.Element;
  if (!read) {
    content = (
      <EmptyState
        icon="i-review:reviewFiles"
        title="还没有打开任何文件"
        hint="从右侧目录选择文件, 或在上方搜索 Memory 正文"
        className="min-h-0 flex-1 px-4 text-center"
      />
    );
  } else if (read.state === 'loading') {
    content = (
      <div className="ema-memory-reader-loading" role="status" aria-label="正在读取 Memory 文件">
        <Spinner size="sm" />
      </div>
    );
  } else if (read.state === 'failed') {
    content = (
      <div className="p-4">
        <Callout variant="danger">{read.message}</Callout>
        <Button size="sm" className="mt-3" onClick={() => onOpen(read.path)}>重新读取</Button>
      </div>
    );
  } else {
    content = (
      <>
        <div className="ema-memory-document-actions">
          <Button
            variant="ghost"
            size="sm"
            icon="i-lucide:folder-search-2"
            onClick={() => void tauriBridge.revealInFolder(read.document.absolutePath)
              .catch(cause => setActionError(errorMessage(cause, '在文件管理器中定位失败')))}
          >
            打开所在文件夹
          </Button>
        </div>
        {actionError && <Callout variant="danger">{actionError}</Callout>}
        {read.document.truncated && (
          <Callout variant="info">文件较大, 这里只展示开头部分; 如需完整内容, 可打开所在文件夹查看.</Callout>
        )}
        <div key={read.path} className="ema-memory-document-scroll">
          <MemoryDocument document={read.document} />
        </div>
      </>
    );
  }

  return <div className="ema-memory-reader ema-memory-reader-bg" aria-label="Memory 文件内容">{content}</div>;
});

const MemoryDocument = memo(function MemoryDocument({ document }: {
  document: MemoryFileContent;
}): JSX.Element {
  return <div className="ema-memory-document"><Markdown source={document.content} /></div>;
});

const MemorySearchResults = memo(function MemorySearchResults({ result, selectedPath, onOpen }: {
  result: MemorySearchResult;
  selectedPath: string | null;
  onOpen: (path: string) => void;
}): JSX.Element {
  return (
    <div className="ema-memory-search-results">
      {result.matches.length === 0 && <EmptyState size="sm" icon="i-lucide:search-x" title="没有找到相关内容" />}
      {result.matches.map(match => (
        <MemorySearchMatch
          key={`${match.path}:${match.matchLineNumber}`}
          match={match}
          selected={selectedPath === match.path}
          onOpen={onOpen}
        />
      ))}
      {result.truncated && <Callout variant="info">当前展示前 {result.matches.length} 条结果, 可缩小搜索范围后继续查找.</Callout>}
    </div>
  );
});

const MemorySearchMatch = memo(function MemorySearchMatch({ match, selected, onOpen }: {
  match: MemorySearchResult['matches'][number];
  selected: boolean;
  onOpen: (path: string) => void;
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="ema-memory-search-match"
      data-selected={selected || undefined}
      aria-pressed={selected}
      onClick={() => onOpen(match.path)}
    >
      <span className="truncate font-semibold" title={match.path}>{match.path}</span>
      <span className="text-[var(--ema-text-tertiary)]">第 {match.matchLineNumber} 行</span>
      <span className="line-clamp-3 whitespace-pre-wrap font-normal">{match.content}</span>
    </Button>
  );
});

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
