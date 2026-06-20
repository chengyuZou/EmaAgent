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
    <div className="flex flex-col gap-1 text-xs text-neutral-400 rounded-lg bg-violet-900/20 border border-violet-500/20 px-2.5 py-1.5">
      <button
        className="flex items-center gap-1.5 font-medium text-violet-400/80 hover:text-violet-300 transition-colors text-left w-full"
        onClick={() => setOpen((v) => !v)}
      >
        {allDone
          ? <span className="i-mdi:check-circle-outline text-violet-400 shrink-0" aria-hidden />
          : <Spinner size="sm" />
        }
        <span className="flex-1">
          {allDone ? `已检索 ${timelines.length} 条剧情线` : '检索剧情线…'}
        </span>
        <span className="text-neutral-500">{open ? '▼' : '▶'}</span>
      </button>

      {open && timelines.length > 0 && (
        <div className="flex flex-col gap-0.5 pl-0.5 pt-0.5">
          {timelines.map((t) => (
            <div key={t} className="flex items-center gap-1.5">
              {completed.has(t)
                ? <span className="i-mdi:check text-violet-400/70 shrink-0" aria-hidden />
                : <span className="i-mdi:dots-horizontal text-neutral-500 shrink-0" aria-hidden />
              }
              <span className={completed.has(t) ? 'text-neutral-300' : 'text-neutral-500'}>{t}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
