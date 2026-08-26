// 文档行展开后的分块预览:游标分页加载 chunk 列表。
import { useCallback, useEffect, useState, type CSSProperties, type JSX } from 'react';
import { Button, Spinner } from '@ema-agent/ui';
import { knowledgeApi, type DocumentChunksResult } from '../../api/knowledge.js';

type ChunkSummary = DocumentChunksResult['items'][number];

export function ChunkViewer({ assetId, closing }: { assetId: string; closing?: boolean }): JSX.Element {
  const [items, setItems]           = useState<ChunkSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading]       = useState(false);
  const [loaded, setLoaded]         = useState(false);

  const load = useCallback(async (cursor?: number): Promise<void> => {
    setLoading(true);
    try {
      const page = await knowledgeApi.listChunks(assetId, { cursor, limit: 20 });
      setItems((prev) => (cursor === undefined ? page.items : [...prev, ...page.items]));
      setNextCursor(page.nextCursor);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [assetId]);

  useEffect(() => {
    void load(undefined);
  }, [load]);

  return (
    <div className={`${closing ? 'ema-fade-out' : 'ema-slide-down'} flex flex-col gap-1.5 px-3 py-2.5
                    border-t border-[var(--ema-border)] bg-[var(--ema-surface-0)]`}>
      {!loaded && loading ? (
        <div className="flex justify-center py-3 ema-fade-in"><Spinner size="sm" /></div>
      ) : items.length === 0 ? (
        <p className="text-xs py-3 text-center text-[var(--ema-text-tertiary)] ema-fade-in">该文档没有分块</p>
      ) : (
        items.map((ch, i) => (
          <div
            key={ch.id}
            className="ema-stagger-in rounded-lg bg-[var(--ema-surface-1)] px-2.5 py-2 ema-card-decorate ema-card-decorate--starfield"
            style={{ '--stagger-i': i % 20 } as CSSProperties}
          >
            <div className="flex items-center gap-2 mb-1 text-[10px] text-[var(--ema-text-tertiary)]">
              <span className="font-mono shrink-0">#{i + 1}</span>
              {ch.page !== undefined && <span className="shrink-0">第 {ch.page} 页</span>}
              <span className="shrink-0">{ch.tokenCount} tok</span>
              <span className={`shrink-0 inline-flex items-center gap-0.5 ${ch.hasEmbedding ? 'text-[var(--ema-success-text)]' : 'text-[var(--ema-text-tertiary)]'}`}>
                <span className={ch.hasEmbedding ? 'i-mdi:check-circle-outline' : 'i-mdi:circle-outline'} aria-hidden />
                {ch.hasEmbedding ? '已嵌入' : '仅 FTS'}
              </span>
              {ch.sectionPath.length > 0 && (
                <span className="truncate opacity-70" title={ch.sectionPath.join(' / ')}>
                  {ch.sectionPath.join(' / ')}
                </span>
              )}
            </div>
            <p className="text-xs text-[var(--ema-text-secondary)] leading-relaxed line-clamp-3">{ch.text}</p>
          </div>
        ))
      )}

      {nextCursor !== null && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full ema-fade-in"
          disabled={loading}
          onClick={() => void load(nextCursor)}
        >
          {loading ? <Spinner size="sm" /> : '加载更多 chunk'}
        </Button>
      )}
    </div>
  );
}
