// 文档行展开后的分块预览:游标分页加载 chunk 列表与检索使用统计。
import { useCallback, useEffect, useState, type CSSProperties, type JSX } from 'react';
import { Button, Spinner } from '@ema-agent/ui';
import { kbApi, type ChunkSummaryWire, type AssetUsageWire } from '../../api/knowledge-base.js';

export function ChunkViewer({ assetId, closing }: { assetId: string; closing?: boolean }): JSX.Element {
  const [items, setItems]           = useState<ChunkSummaryWire[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading]       = useState(false);
  const [loaded, setLoaded]         = useState(false);
  const [usage, setUsage]           = useState<AssetUsageWire | null>(null);

  const load = useCallback(async (cursor?: number): Promise<void> => {
    setLoading(true);
    try {
      const page = await kbApi.listChunks(assetId, { cursor, limit: 20 });
      setItems((prev) => (cursor === undefined ? page.items : [...prev, ...page.items]));
      setNextCursor(page.nextCursor);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [assetId]);

  useEffect(() => {
    void load(undefined);
    void kbApi.getUsage(assetId).then(setUsage).catch(() => { /* ignore */ });
  }, [load, assetId]);

  return (
    <div className={`${closing ? 'ema-fade-out' : 'ema-slide-down'} flex flex-col gap-1.5 px-3 py-2.5
                    border-t border-[var(--ema-border)] bg-[var(--ema-surface-0)]`}>
      {/* ── Usage: which sessions retrieved this doc, how many times ── */}
      {usage && (usage.totalCalls > 0 ? (
        <div className="ema-fade-in flex flex-col gap-1 pb-1.5 mb-0.5 border-b border-[var(--ema-border)]">
          <p className="text-[11px] text-[var(--ema-text-secondary)]">
            在 <b>{usage.sessions.length}</b> 个会话中被检索 <b>{usage.totalCalls}</b> 次
          </p>
          <div className="flex flex-wrap gap-1">
            {usage.sessions.slice(0, 8).map((s) => (
              <span key={s.sessionId}
                    className="ema-stagger-in text-[10px] px-1.5 py-0.5 rounded-full
                               bg-[var(--ema-surface-2)] text-[var(--ema-text-tertiary)]">
                {s.title || '(未命名)'} · {s.calls}
              </span>
            ))}
            {usage.sessions.length > 8 && (
              <span className="text-[10px] px-1 py-0.5 text-[var(--ema-text-tertiary)] opacity-60">
                +{usage.sessions.length - 8}
              </span>
            )}
          </div>
        </div>
      ) : (
        <p className="ema-fade-in text-[11px] text-[var(--ema-text-tertiary)] pb-1">尚未在任何会话中被检索</p>
      ))}

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
