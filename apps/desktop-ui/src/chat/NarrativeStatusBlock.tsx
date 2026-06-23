import { useState, useEffect } from 'react';
import { Spinner } from '@ema-agent/ui';
import type { AssistantSlice } from '../stores/conversation-store.js';

type NarrativeSlice = Extract<AssistantSlice, { type: 'narrative_status' }>;

export function NarrativeStatusBlock({ slice }: { slice: NarrativeSlice }): React.JSX.Element {
  const timelines = slice.timelines;
  const completed = new Set(slice.completedTimelines);
  const allDone   = timelines.length > 0 && completed.size >= timelines.length;

  const [open, setOpen] = useState(true);

  // Auto-collapse once all timelines finish.
  useEffect(() => {
    if (allDone) setOpen(false);
  }, [allDone]);

  return (
    <div className="flex flex-col gap-1 text-xs rounded-lg px-2.5 py-1.5"
         style={{ color: 'var(--ema-text-tertiary)', background: 'var(--ema-info-muted)', borderColor: 'var(--ema-info)', borderWidth: 1 }}>
      <button
        className="flex items-center gap-1.5 font-medium transition-colors text-left w-full"
        style={{ color: 'var(--ema-info)' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ema-info-hover)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ema-info)'; }}>
        {allDone
          ? <span className="i-mdi:check-circle-outline shrink-0" style={{ color: 'var(--ema-info)' }} aria-hidden />
          : <Spinner size="sm" />
        }
        <span className="flex-1">
          {allDone ? `已检索 ${timelines.length} 条剧情线` : '检索剧情线…'}
        </span>
        <span style={{ color: 'var(--ema-text-tertiary)' }}>{open ? '▼' : '▶'}</span>
      </button>

      {open && timelines.length > 0 && (
        <div className="flex flex-col gap-0.5 pl-0.5 pt-0.5">
          {timelines.map((t) => (
            <div key={t} className="flex items-center gap-1.5">
              {completed.has(t)
                ? <span className="i-mdi:check shrink-0" style={{ color: 'var(--ema-info)' }} aria-hidden />
                : <span className="i-mdi:dots-horizontal shrink-0" style={{ color: 'var(--ema-text-tertiary)' }} aria-hidden />
              }
              <span style={{ color: completed.has(t) ? 'var(--ema-text-secondary)' : 'var(--ema-text-tertiary)' }}>{t}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
