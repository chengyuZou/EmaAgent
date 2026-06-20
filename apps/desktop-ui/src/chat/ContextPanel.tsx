import { useState, type JSX } from 'react';
import { Badge } from '@ema-agent/ui';
import { useConversationStore } from '../stores/conversation-store.js';
import type { MemoryRecallLayer, MemoryRecallLayerReport } from '@ema-agent/contracts';

// ── Constants ─────────────────────────────────────────────────────────────────

const LAYER_LABELS: Record<MemoryRecallLayer, string> = {
  layer0: 'L0 锚点',
  layer1: 'L1 关联',
  layer2: 'L2 摘要',
};

const LAYER_ORDER: MemoryRecallLayer[] = ['layer0', 'layer1', 'layer2'];

const STATUS_BADGE: Record<MemoryRecallLayerReport['status'], {
  variant: 'success' | 'neutral' | 'danger';
  label: string;
}> = {
  succeeded: { variant: 'success', label: '已召回' },
  skipped:   { variant: 'neutral', label: '已跳过' },
  failed:    { variant: 'danger',  label: '失败'   },
};

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Status-bar button + popover showing memory recall evidence for the current
 * session's most recent turn. Driven by `recallEvidenceMap` in conversation-store.
 * Returns null when no evidence has arrived yet (no turn completed this session).
 */
export function ContextPanel(): JSX.Element | null {
  const viewedId = useConversationStore((s) => s.viewedSessionId);
  const evidence = useConversationStore((s) =>
    viewedId ? s.recallEvidenceMap.get(viewedId as string) : undefined,
  );
  const [open, setOpen] = useState(false);

  if (!evidence || Object.keys(evidence).length === 0) return null;

  const succeededItems = LAYER_ORDER.reduce<number>((sum, layer) => {
    const r = evidence[layer];
    return sum + (r?.status === 'succeeded' ? r.itemCount : 0);
  }, 0);
  const hasFailed = LAYER_ORDER.some((l) => evidence[l]?.status === 'failed');

  const triggerVariant: 'success' | 'danger' | 'neutral' = hasFailed
    ? 'danger'
    : succeededItems > 0
      ? 'success'
      : 'neutral';

  return (
    <div className="relative">
      {/* Trigger */}
      <button
        className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
        onClick={() => setOpen((v) => !v)}
        title="查看记忆召回"
      >
        <span className="i-mdi:brain-outline text-sm" aria-hidden />
        <span>记忆</span>
        <Badge variant={triggerVariant}>
          {succeededItems}
        </Badge>
      </button>

      {/* Popover */}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute bottom-full right-0 mb-2 z-50 w-72 bg-neutral-900 border border-neutral-700/80 rounded-xl shadow-2xl p-3"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-xs font-semibold text-neutral-400 mb-2.5 flex items-center gap-1.5">
              <span className="i-mdi:brain-outline text-sm" aria-hidden />
              记忆召回 — 本轮
            </p>

            <div className="flex flex-col gap-2">
              {LAYER_ORDER.map((layer) => {
                const report = evidence[layer];
                if (!report) return null;
                const st = STATUS_BADGE[report.status];

                return (
                  <div key={layer} className="flex items-start gap-2 text-xs">
                    <span className="text-neutral-500 w-14 shrink-0 pt-0.5 font-mono">
                      {LAYER_LABELS[layer]}
                    </span>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge variant={st.variant}>{st.label}</Badge>

                        {report.status === 'succeeded' && (
                          <>
                            <span className="text-neutral-300">{report.itemCount} 条</span>
                            <span className="text-neutral-500">{report.tokenEstimate} tok</span>
                            <span className="text-neutral-600">{report.durationMs} ms</span>
                          </>
                        )}

                        {report.status === 'skipped' && report.skippedReason && (
                          <span className="text-neutral-600 truncate max-w-[10rem]" title={report.skippedReason}>
                            {report.skippedReason}
                          </span>
                        )}
                      </div>

                      {report.error && (
                        <p className="text-red-400 mt-1 line-clamp-2">{report.error}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
