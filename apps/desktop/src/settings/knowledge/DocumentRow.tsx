// 单个文档行:状态徽标、重嵌/删除动作与展开的分块预览。
import { useEffect, useState, type JSX } from 'react';
import { Badge, ConfirmDialog, EntityRow, IconButton } from '@ema-agent/ui';
import { useKnowledgeStore } from '../../stores/knowledge.js';
import { showToast } from '../../lib/toast.js';
import { knowledgeApi, type DocumentAsset } from '../../api/knowledge.js';
import { ChunkViewer } from './ChunkViewer.js';

const STATUS_LABEL: Record<string, string> = {
  ready:    '已索引',
  indexing: '索引中',
  failed:   '错误',
};

const STATUS_VARIANT: Record<string, 'success' | 'warn' | 'neutral' | 'danger'> = {
  ready:    'success',
  indexing: 'warn',
  failed:   'danger',
};

export function DocumentRow({ doc, kbId, onDelete, index }: {
  doc: DocumentAsset;
  kbId: string;
  onDelete(): void;
  index?: number;
}): JSX.Element {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Delayed unmount so the chunk viewer plays an exit animation on collapse.
  const [chunkMounted, setChunkMounted] = useState(false);
  useEffect(() => {
    if (expanded) { setChunkMounted(true); return; }
    const t = setTimeout(() => setChunkMounted(false), 200); // ≈ --ema-duration-base
    return () => clearTimeout(t);
  }, [expanded]);

  const [reembedding, setReembedding] = useState(false);

  // stale 标记由后端维护(库 Embedding 模型变更时标出,需重建)。
  const needsReembed = doc.embeddingStale === true;

  async function handleDelete(): Promise<void> {
    setConfirmingDelete(false);
    setDeleting(true);
    try {
      await useKnowledgeStore.getState().deleteDocument(doc.id);
      onDelete();
    } catch {
      showToast('删除失败', { variant: 'danger' });
    } finally {
      setDeleting(false);
    }
  }

  async function handleReembed(): Promise<void> {
    setReembedding(true);
    try {
      // 202 入队后立即返回; 重建在后台执行, 完成后文档列表由 SSE 驱动刷新。
      await knowledgeApi.reembed(kbId, { assetIds: [doc.id] });
      showToast('已加入后台重建', { variant: 'success' });
    } catch {
      showToast('重嵌失败（请先在库详情页配置嵌入模型）', { variant: 'danger' });
    } finally {
      setReembedding(false);
    }
  }

  return (
    <EntityRow
      decorate="ema-card-decorate--starfield"
      active={expanded}
      index={index}
      className={`flex flex-col ${expanded ? 'ema-row-active' : ''}`}
    >
      <div
        className="flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-ema"
        onClick={() => setExpanded((v) => !v)}
      >
        <span
          className={`shrink-0 text-base text-[var(--ema-text-tertiary)] transition-ema
                      ${expanded ? 'i-solar:alt-arrow-down-linear' : 'i-solar:alt-arrow-right-linear'}`}
          aria-hidden
        />
        <span className="i-solar:document-bold text-[var(--ema-text-tertiary)] shrink-0 text-lg" aria-hidden />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-[var(--ema-text-primary)] truncate" title={doc.filePath}>{doc.fileName}</p>
          <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">
            {doc.wordCount.toLocaleString()} 词{doc.pageCount ? ` · ${doc.pageCount} 页` : ''}
            {doc.embeddingModel ? (
              <span className={`ml-2 font-mono ema-fade-in ${needsReembed ? 'text-[var(--ema-danger)]' : 'text-[var(--ema-text-tertiary)]'}`}>
                {needsReembed && <span className="i-mdi:alert-circle-outline mr-0.5 align-middle" aria-hidden />}{doc.embeddingModel}{needsReembed ? '（需重嵌）' : ''}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
          <Badge variant={STATUS_VARIANT[doc.status] ?? 'neutral'} className="text-xs">
            {STATUS_LABEL[doc.status] ?? doc.status}
          </Badge>
          {needsReembed && (
            <IconButton
              variant="default"
              size="sm"
              label="重新嵌入此文档"
              icon={reembedding ? 'i-solar:refresh-bold animate-spin' : 'i-solar:refresh-bold'}
              onClick={() => void handleReembed()}
              disabled={reembedding}
              className="ema-fade-in"
            />
          )}
          <IconButton
            variant="default"
            size="sm"
            label="删除"
            icon={deleting ? 'i-solar:refresh-bold animate-spin' : 'i-solar:trash-bin-2-bold'}
            onClick={() => setConfirmingDelete(true)}
            disabled={deleting}
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        message={`删除「${doc.fileName}」? 文档、索引与任务记录将一并永久移除。`}
        confirmText="删除"
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmingDelete(false)}
      />

      {chunkMounted && <ChunkViewer kbId={kbId} assetId={doc.id} closing={!expanded} />}
    </EntityRow>
  );
}
