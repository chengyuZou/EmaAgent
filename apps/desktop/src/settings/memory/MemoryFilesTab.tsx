import { memo, useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Button, Callout, EmptyState, IconButton, Markdown, Spinner, Tooltip } from '@ema-agent/ui';
import { memoryApi, type MemoryFileContent } from '../../api/memory.js';
import { tauriBridge } from '../../lib/tauri/tauriBridge.js';
import { PageHeader } from '../shared/PageHeader.js';
import { MemoryFileTree } from './memoryFileTree.js';

type MemoryRead =
  | { state: 'loading'; path: string }
  | { state: 'ready'; path: string; document: MemoryFileContent }
  | { state: 'failed'; path: string; message: string };

export function MemoryFilesTab(): JSX.Element {
  const [treeOpen, setTreeOpen] = useState(true);
  const [read, setRead] = useState<MemoryRead | null>(null);
  const readRequest = useRef<AbortController | null>(null);

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

  const toggleTree = useCallback(() => setTreeOpen(value => !value), []);

  useEffect(() => () => {
    readRequest.current?.abort();
  }, []);

  return (
    <div className="ema-memory-files">
      <PageHeader title="Memory 文件" description="浏览目录并阅读 Memory 文件内容" />

      <section className="ema-memory-browser" aria-label="Memory 文件浏览器">
        <div className="ema-memory-browser-header">
          <Tooltip content={read?.path} variant="card">
            <span className="ema-memory-location">
              {read?.path ?? '请选择一份 Memory 文件'}
            </span>
          </Tooltip>
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
              <span>Memory 目录</span>
            </div>
            <div className="ema-memory-list-content">
              <MemoryFileTree
                selectedPath={read?.path ?? null}
                onOpen={openFile}
              />
            </div>
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
        hint="从右侧目录选择要阅读的 Memory 文件"
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

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
