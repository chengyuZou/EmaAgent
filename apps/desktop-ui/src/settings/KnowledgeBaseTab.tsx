/**
 * KnowledgeBaseTab — document ingest, list, delete, and search test.
 */
import { useState, useEffect, type JSX } from 'react';
import { Button, IconButton, Input, Spinner, Badge, Callout, ScrollArea } from '@ema-agent/ui';
import { useKbStore } from '../stores/kb-store.js';
import { tauriBridge } from '../lib/tauri-bridge.js';
import { showToast } from '../lib/toast.js';
import type { DocumentAssetWire } from '../api/knowledge-base.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  indexed:  '已索引',
  indexing: '索引中',
  pending:  '等待中',
  error:    '错误',
};

const STATUS_VARIANT: Record<string, 'success' | 'warn' | 'neutral' | 'danger'> = {
  indexed:  'success',
  indexing: 'warn',
  pending:  'neutral',
  error:    'danger',
};

function fileNameFromPath(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() ?? p;
}

// ── DocumentRow ───────────────────────────────────────────────────────────────

function DocumentRow({ doc, onDelete }: { doc: DocumentAssetWire; onDelete(): void }): JSX.Element {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete(): Promise<void> {
    setDeleting(true);
    try {
      await useKbStore.getState().deleteDocument(doc.id);
      onDelete();
    } catch {
      showToast('删除失败', { variant: 'danger' });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-neutral-900 hover:bg-neutral-800/80 transition-colors">
      <span className="i-solar:document-bold text-neutral-500 shrink-0 text-lg" aria-hidden />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-neutral-200 truncate" title={doc.filePath}>{doc.fileName}</p>
        <p className="text-xs text-neutral-500 mt-0.5">
          {doc.wordCount.toLocaleString()} 词{doc.pageCount ? ` · ${doc.pageCount} 页` : ''}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Badge variant="neutral" className="text-xs">
          {doc.useCount > 0 ? `被选 ${doc.useCount} 次` : '未使用'}
        </Badge>
        <Badge variant={STATUS_VARIANT[doc.status] ?? 'neutral'} className="text-xs">
          {STATUS_LABEL[doc.status] ?? doc.status}
        </Badge>
        <IconButton
          variant="default"
          size="sm"
          label="删除"
          icon={deleting ? 'i-solar:spinner-bold animate-spin' : 'i-solar:trash-bin-2-bold'}
          onClick={() => void handleDelete()}
          disabled={deleting}
        />
      </div>
    </div>
  );
}

// ── IngestForm ────────────────────────────────────────────────────────────────

function IngestForm({ onDone }: { onDone(): void }): JSX.Element {
  const ingesting   = useKbStore((s) => s.ingesting);
  const ingestError = useKbStore((s) => s.ingestError);

  const [filePath, setFilePath] = useState('');

  async function pickFile(): Promise<void> {
    const path = await tauriBridge.openFileDialog({
      filters: [
        { name: '文档', extensions: ['pdf', 'md', 'txt', 'docx', 'pptx', 'xlsx'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (path) setFilePath(path);
  }

  async function handleIngest(): Promise<void> {
    if (!filePath.trim()) {
      showToast('请选择或输入文件路径', { variant: 'warning' });
      return;
    }
    await useKbStore.getState().ingest(filePath.trim());
    if (!useKbStore.getState().ingestError) {
      setFilePath('');
      onDone();
      showToast('导入成功', { variant: 'success' });
    }
  }

  return (
    <div className="flex flex-col gap-3 p-4 rounded-xl bg-neutral-900 border border-neutral-700/60">
      <p className="text-sm font-medium text-neutral-300">导入文档</p>

      {/* File path row */}
      <div className="flex gap-2">
        <Input
          className="flex-1 font-mono text-xs"
          placeholder="文件绝对路径，例如 D:\docs\paper.pdf"
          value={filePath}
          onChange={(e) => setFilePath(e.target.value)}
        />
        <Button variant="secondary" size="sm" onClick={() => void pickFile()}>
          浏览…
        </Button>
      </div>

      {ingestError && (
        <Callout variant="danger" className="text-xs">{ingestError}</Callout>
      )}

      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          disabled={ingesting || !filePath.trim()}
          onClick={() => void handleIngest()}
        >
          {ingesting ? <><Spinner size="sm" className="mr-1.5" />导入中…</> : '开始导入'}
        </Button>
      </div>
    </div>
  );
}

// ── SearchTest ────────────────────────────────────────────────────────────────

function SearchTest(): JSX.Element {
  const searchResult  = useKbStore((s) => s.searchResult);
  const searchLoading = useKbStore((s) => s.searchLoading);
  const searchError   = useKbStore((s) => s.searchError);
  const [query, setQuery] = useState('');

  async function handleSearch(): Promise<void> {
    await useKbStore.getState().search(query);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Input
          className="flex-1 text-sm"
          placeholder="输入查询语句测试检索…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch(); }}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={searchLoading || !query.trim()}
          onClick={() => void handleSearch()}
        >
          {searchLoading ? <Spinner size="sm" /> : '检索'}
        </Button>
      </div>

      {searchError && (
        <Callout variant="danger" className="text-xs">{searchError}</Callout>
      )}

      {searchResult && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-neutral-500">
            "{searchResult.query}" — {searchResult.hits.length} 条结果
          </p>
          {searchResult.hits.length === 0 ? (
            <p className="text-sm text-neutral-500 py-3 text-center">未找到相关内容</p>
          ) : (
            <div className="flex flex-col gap-2">
              {searchResult.hits.map((hit) => (
                <div
                  key={hit.chunkId}
                  className="p-3 rounded-xl bg-neutral-900 border border-neutral-700/40"
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xs text-neutral-500 font-mono">{hit.source.fileName}</span>
                    {hit.source.page && (
                      <span className="text-xs text-neutral-600">第 {hit.source.page} 页</span>
                    )}
                    <span className="ml-auto text-xs text-primary-400 font-mono">
                      {(hit.score * 100).toFixed(1)}%
                    </span>
                  </div>
                  <p className="text-xs text-neutral-300 leading-relaxed line-clamp-4">
                    {hit.text}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── KnowledgeBaseTab ──────────────────────────────────────────────────────────

export function KnowledgeBaseTab(): JSX.Element {
  const documents = useKbStore((s) => s.documents);
  const loading   = useKbStore((s) => s.loading);
  const error     = useKbStore((s) => s.error);
  const [showIngest, setShowIngest] = useState(false);

  useEffect(() => {
    void useKbStore.getState().loadDocuments();
  }, []);

  return (
    <div className="flex flex-col gap-6">

      {/* ── Document list ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-neutral-300">
            已导入文档
            {documents.length > 0 && (
              <span className="ml-2 text-xs text-neutral-500">({documents.length})</span>
            )}
          </h2>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowIngest((v) => !v)}
          >
            <span className="i-solar:add-circle-bold mr-1" aria-hidden />
            {showIngest ? '收起' : '导入文档'}
          </Button>
        </div>

        {showIngest && (
          <IngestForm onDone={() => setShowIngest(false)} />
        )}

        {error && (
          <Callout variant="danger" className="text-xs">{error}</Callout>
        )}

        {loading ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner size="md" />
          </div>
        ) : documents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-28 gap-2 text-neutral-500">
            <span className="i-solar:database-bold text-2xl opacity-40" aria-hidden />
            <p className="text-sm">暂无文档，点击「导入文档」添加</p>
          </div>
        ) : (
          <ScrollArea className="max-h-72">
            <div className="flex flex-col gap-1.5 pr-2">
              {documents.map((doc) => (
                <DocumentRow
                  key={doc.id}
                  doc={doc}
                  onDelete={() => void useKbStore.getState().loadDocuments()}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </section>

      {/* ── Search test ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-300">检索测试</h2>
        <SearchTest />
      </section>
    </div>
  );
}
