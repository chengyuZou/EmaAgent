/**
 * 知识库设置主装配:知识库注册、检索模型、检索参数、处理队列、文档列表与检索测试。
 * 子部件各自成文件,这里只取数与拼块。
 */
import { useState, useEffect, useCallback, type JSX } from 'react';
import { Button, Callout, EmptyState, Spinner } from '@ema-agent/ui';
import { useKnowledgeStore } from '../../stores/knowledge.js';
import {
  documentNeedsReembed,
  type ResolvedEmbedSelection,
} from './embeddingSelection.js';
import { LibraryManager } from './LibraryManager.js';
import { KbModelSettings } from './KbModelSettings.js';
import { ProcessingQueue } from './ProcessingQueue.js';
import { IngestForm } from './IngestForm.js';
import { DocumentRow } from './DocumentRow.js';
import { SearchTest } from './SearchTest.js';
import { KnowledgeSettings } from './KnowledgeSettings.js';

export function KnowledgeBaseTab(): JSX.Element {
  const documents = useKnowledgeStore((s) => s.documents);
  const loading   = useKnowledgeStore((s) => s.loading);
  const error     = useKnowledgeStore((s) => s.error);
  const [showIngest,       setShowIngest]       = useState(false);
  const [ingestFormMounted, setIngestFormMounted] = useState(false);
  const [embedSelection, setEmbedSelection] = useState<ResolvedEmbedSelection | undefined>();
  const activeKbId = useKnowledgeStore((state) => state.libs.find((lib) => lib.isActive)?.id);

  const handleEmbedModelChanged = useCallback((selection: ResolvedEmbedSelection | undefined): void => {
    setEmbedSelection(selection);
    void useKnowledgeStore.getState().loadDocuments();
  }, []);

  // Delayed unmount so IngestForm exit animation plays.
  useEffect(() => {
    if (showIngest) { setIngestFormMounted(true); return; }
    const t = setTimeout(() => setIngestFormMounted(false), 220);
    return () => clearTimeout(t);
  }, [showIngest]);

  useEffect(() => {
    void useKnowledgeStore.getState().loadDocuments();
  }, []);

  return (
    <div className="flex flex-col gap-6">

      {/* ── KB library registry ── */}
      <LibraryManager />

      {/* ── Retrieval models (embed + rerank) ── */}
      <KbModelSettings onEmbedModelChanged={handleEmbedModelChanged} />

      <KnowledgeSettings />

      {/* ── Background processing queue ── */}
      <ProcessingQueue />

      {/* ── Document list ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">
            已导入文档
            {documents.length > 0 && (
              <span className="ml-2 text-xs text-[var(--ema-text-tertiary)]">({documents.length})</span>
            )}
            {documents.length > 0 && embedSelection && (() => {
              const need = documents.filter((document) =>
                documentNeedsReembed(document, embedSelection)).length;
              return need > 0 ? (
                <span className="ml-2 text-xs font-mono text-[var(--ema-danger)]">
                  · {need}/{documents.length} 需重嵌
                </span>
              ) : null;
            })()}
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

        {ingestFormMounted && (
          <div className={showIngest ? 'ema-slide-down' : 'ema-fade-out'}>
            <IngestForm onDone={() => setShowIngest(false)} />
          </div>
        )}

        {error && (
          <Callout variant="danger" className="text-xs ema-fade-in">{error}</Callout>
        )}

        {loading ? (
          <div className="flex h-24 items-center justify-center ema-fade-in">
            <Spinner size="md" />
          </div>
        ) : documents.length === 0 ? (
          <EmptyState icon="i-solar:database-bold" title="暂无文档，点击「导入文档」添加" animate size="sm" className="h-28" />
        ) : (
          <div className="ema-fade-in flex flex-col gap-1.5 pr-2">
            {documents.map((doc, i) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                index={i}
                currentEmbed={embedSelection}
                kbId={activeKbId ?? ''}
                onDelete={() => void useKnowledgeStore.getState().loadDocuments()}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Search test ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">检索测试</h2>
        <SearchTest />
      </section>
    </div>
  );
}
