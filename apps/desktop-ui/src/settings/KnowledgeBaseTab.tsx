/**
 * KnowledgeBaseTab — document ingest, list, delete, and search test.
 */
import { useState, useEffect, type CSSProperties, type JSX } from 'react';
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
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl
                    bg-[var(--ema-surface-1)] hover:bg-[var(--ema-surface-2)]
                    transition-colors duration-[var(--ema-duration-base)]">
      <span className="i-solar:document-bold text-[var(--ema-text-tertiary)] shrink-0 text-lg" aria-hidden />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--ema-text-primary)] truncate" title={doc.filePath}>{doc.fileName}</p>
        <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">
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
    <div className="flex flex-col gap-3 p-4 rounded-xl
                    bg-[var(--ema-surface-1)] border border-[var(--ema-border)]">
      <p className="text-sm font-medium text-[var(--ema-text-secondary)]">导入文档</p>

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
    if (!query.trim()) return;
    await useKbStore.getState().search(query);
  }

  function handleChange(value: string): void {
    setQuery(value);
    // Clearing the box clears stale results so nothing lingers.
    if (!value.trim() && (searchResult || searchError)) {
      useKbStore.getState().clearSearch();
    }
  }

  function handleClear(): void {
    setQuery('');
    useKbStore.getState().clearSearch();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            className="text-sm pr-8"
            placeholder="输入查询语句测试检索…"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch(); }}
          />
          {query && (
            <IconButton
              variant="default"
              size="sm"
              label="清空"
              icon="i-solar:close-circle-bold"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              onClick={handleClear}
            />
          )}
        </div>
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
          <p className="text-xs text-[var(--ema-text-tertiary)]">
            "{searchResult.query}" — {searchResult.hits.length} 条结果
          </p>
          {searchResult.hits.length === 0 ? (
            <p className="text-sm text-[var(--ema-text-tertiary)] py-3 text-center">未找到相关内容</p>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
              {searchResult.hits.map((hit, i) => (
                <div
                  key={hit.chunkId}
                  className="p-3 rounded-xl bg-[var(--ema-surface-1)] border border-[var(--ema-border)] ema-stagger-in"
                  style={{ '--stagger-i': i } as CSSProperties}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xs text-[var(--ema-text-tertiary)] font-mono truncate">{hit.source.fileName}</span>
                    {hit.source.page && (
                      <span className="text-xs text-[var(--ema-text-tertiary)] shrink-0">第 {hit.source.page} 页</span>
                    )}
                    <span className="ml-auto text-xs text-[var(--ema-primary)] font-mono shrink-0">
                      {(hit.score * 100).toFixed(1)}%
                    </span>
                  </div>
                  <p className="text-xs text-[var(--ema-text-secondary)] leading-relaxed line-clamp-4">
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
          <h2 className="text-sm font-medium text-[var(--ema-text-secondary)]">
            已导入文档
            {documents.length > 0 && (
              <span className="ml-2 text-xs text-[var(--ema-text-tertiary)]">({documents.length})</span>
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
          <div className="flex flex-col items-center justify-center h-28 gap-2 text-[var(--ema-text-tertiary)]">
            <span className="i-solar:database-bold text-2xl opacity-40" aria-hidden />
            <p className="text-sm">暂无文档，点击「导入文档」添加</p>
          </div>
        ) : (
          <ScrollArea className="max-h-72">
            <div className="flex flex-col gap-1.5 pr-2">
              {documents.map((doc, i) => (
                <div key={doc.id} className="ema-stagger-in" style={{ '--stagger-i': i } as CSSProperties}>
                <DocumentRow
                  doc={doc}
                  onDelete={() => void useKbStore.getState().loadDocuments()}
                />
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </section>

      {/* ── Search test ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-[var(--ema-text-secondary)]">检索测试</h2>
        <SearchTest />
      </section>
    </div>
  );
}
