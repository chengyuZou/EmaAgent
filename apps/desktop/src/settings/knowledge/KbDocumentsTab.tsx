// 文档 Tab:导入入口、文档状态列表与分块预览;未配置 Embedding 时导入禁用(检索 Tab 同理)。
import { useEffect, useState, type JSX } from 'react';
import { Button, Callout, EmptyState, Spinner } from '@ema-agent/ui';
import { useKnowledgeStore } from '../../stores/knowledge.js';
import type { KnowledgeLibrary } from '../../api/knowledge.js';
import { IngestForm } from './IngestForm.js';
import { DocumentRow } from './DocumentRow.js';

export function KbDocumentsTab({ lib }: { lib: KnowledgeLibrary }): JSX.Element {
  const documents = useKnowledgeStore((s) => s.documents);
  const loading   = useKnowledgeStore((s) => s.loading);
  const error     = useKnowledgeStore((s) => s.error);
  const [showIngest, setShowIngest] = useState(false);
  const [ingestFormMounted, setIngestFormMounted] = useState(false);

  // Delayed unmount so IngestForm exit animation plays.
  useEffect(() => {
    if (showIngest) { setIngestFormMounted(true); return; }
    const t = setTimeout(() => setIngestFormMounted(false), 220);
    return () => clearTimeout(t);
  }, [showIngest]);

  const staleCount = documents.filter((doc) => doc.embeddingStale === true).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--ema-text-primary)]">
          已导入文档
          {documents.length > 0 && (
            <span className="ml-2 text-xs text-[var(--ema-text-tertiary)]">({documents.length})</span>
          )}
          {staleCount > 0 && (
            <span className="ml-2 text-xs font-mono text-[var(--ema-danger)]">
              · {staleCount}/{documents.length} 需重嵌
            </span>
          )}
        </h3>
        <Button
          variant="secondary" size="sm"
          disabled={!lib.embed}
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

      {error && <Callout variant="danger" className="text-xs ema-fade-in">{error}</Callout>}

      {loading ? (
        <div className="flex h-24 items-center justify-center ema-fade-in"><Spinner size="md" /></div>
      ) : documents.length === 0 ? (
        <EmptyState
          icon="i-solar:database-bold"
          title={lib.embed ? '暂无文档，点击「导入文档」添加' : '先配置 Embedding 模型再导入文档'}
          animate size="sm" className="h-28"
        />
      ) : (
        <div className="ema-fade-in flex flex-col gap-1.5 pr-2">
          {documents.map((doc, i) => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              kbId={lib.id}
              index={i}
              onDelete={() => void useKnowledgeStore.getState().loadDocuments()}
            />
          ))}
        </div>
      )}
    </div>
  );
}
