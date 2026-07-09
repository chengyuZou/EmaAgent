/**
 * ModelPicker — dropdown for selecting (providerId, model) before sending.
 *
 * Fetches enabled models from GET /api/providers/models on mount.
 * Groups by provider, supports search filtering, pops UPWARD from the
 * bottom toolbar, uses @ema-agent/ui ScrollArea for the model list.
 */
import { useState, useEffect, useMemo, useRef, type JSX } from 'react';
import { ScrollArea, Badge } from '@ema-agent/ui';
import { modelsApi, type EnabledModelWire } from '../api/models.js';
import { useUiStore } from '../stores/ui-store.js';

export interface ModelSelection {
  providerId: string;
  model:      string;
  reasoning?: boolean;
}

interface ModelPickerProps {
  selected:    ModelSelection | null;
  onSelect(sel: ModelSelection): void;
  onClear():  void;
}

/** Format context window for compact display. */
function fmtCtx(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000)    return `${Math.round(n / 1000)}K`;
  if (n >= 1_000)     return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}

export function ModelPicker({ selected, onSelect, onClear }: ModelPickerProps): JSX.Element {
  const [open, setOpen]       = useState(false);
  const [models, setModels]   = useState<EnabledModelWire[]>([]);
  const [search, setSearch]   = useState('');
  const [loading, setLoading] = useState(true);
  const searchRef             = useRef<HTMLInputElement>(null);

  useEffect(() => {
    modelsApi.listEnabled()
      .then(setModels)
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
  }, []);

  // Focus search input + reset search when dropdown opens
  useEffect(() => {
    if (open) {
      setSearch('');
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open]);

  // Group models by provider, filter by search query
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? models.filter((m) =>
          m.model.toLowerCase().includes(q) ||
          m.providerName.toLowerCase().includes(q),
        )
      : models;

    const map = new Map<string, EnabledModelWire[]>();
    for (const m of filtered) {
      const list = map.get(m.providerId) ?? [];
      list.push(m);
      map.set(m.providerId, list);
    }
    return [...map.entries()].sort(([, a], [, b]) =>
      (a[0]?.providerName ?? '').localeCompare(b[0]?.providerName ?? ''),
    );
  }, [models, search]);

  const selectedModel = selected
    ? models.find((m) => m.providerId === selected.providerId && m.model === selected.model)
    : null;

  const triggerLabel = selectedModel
    ? selectedModel.model
    : (loading ? '加载中…' : '默认模型');

  const triggerTitle = selectedModel
    ? `${selectedModel.providerName} / ${selectedModel.model}`
    : '选择模型';

  return (
    <div className="relative">
      {/* Trigger button */}
      <button
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs max-w-48
                   text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)]
                   hover:bg-[var(--ema-surface-2)]
                   transition-colors duration-[var(--ema-duration-base)]"
        onClick={() => setOpen(!open)}
        title={triggerTitle}
      >
        <span className="i-mdi:robot-outline text-[10px]" aria-hidden />
        <span className="truncate">{triggerLabel}</span>
        <span className="i-mdi:chevron-up text-[10px] shrink-0" aria-hidden />
      </button>

      {/* Dropdown — pops UPWARD (bottom-full) since it's in the bottom toolbar */}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          <div
            className="ema-slide-up absolute bottom-full left-0 mb-1 z-50
                       w-72 max-h-72 flex flex-col rounded-xl
                       bg-[var(--ema-surface-4)] border border-[var(--ema-border)]
                       shadow-[var(--ema-shadow-3)]"
          >
            {/* Search + clear */}
            <div className="flex items-center gap-1 px-3 py-2 border-b border-[var(--ema-border)] shrink-0">
              <input
                ref={searchRef}
                className="flex-1 bg-transparent text-xs outline-none
                           text-[var(--ema-text-primary)] placeholder-[var(--ema-text-tertiary)]"
                placeholder="搜索模型…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setOpen(false);
                }}
              />
              {selected && (
                <button
                  className="shrink-0 text-[10px] px-1
                             text-[var(--ema-text-tertiary)] hover:text-[var(--ema-danger)]
                             transition-colors duration-[var(--ema-duration-base)]"
                  onClick={() => {
                    onClear();
                    useUiStore.getState().setSelectedContextWindow(null);
                    setOpen(false);
                  }}
                  title="恢复默认模型"
                >
                  <span className="i-mdi:close text-[10px]" aria-hidden />
                </button>
              )}
            </div>

            {/* Model list */}
            <ScrollArea orientation="vertical" className="flex-1" viewportClassName="py-1">
              {loading ? (
                <div className="px-3 py-6 text-xs text-[var(--ema-text-tertiary)] text-center">加载中…</div>
              ) : grouped.length === 0 ? (
                <div className="px-3 py-6 text-xs text-[var(--ema-text-tertiary)] text-center">
                  {search ? '无匹配结果' : '暂无已启用的模型'}
                </div>
              ) : (
                grouped.map(([providerId, providerModels]) => (
                  <div key={providerId}>
                    {/* Provider group header */}
                    <div className="px-3 pt-2 pb-0.5 text-[10px] font-medium uppercase tracking-wider select-none
                                    text-[var(--ema-text-tertiary)]">
                      {providerModels[0]?.providerName ?? providerId}
                    </div>
                    {providerModels.map((m) => {
                      const isSelected =
                        selected?.providerId === m.providerId && selected?.model === m.model;
                      return (
                        <button
                          key={`${m.providerId}:${m.model}`}
                          className={
                            'w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs ' +
                            `transition-colors duration-[var(--ema-duration-base)] ` +
                            (isSelected
                              ? 'text-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
                              : 'text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-3)] hover:text-[var(--ema-text-primary)]')
                          }
                          onClick={() => {
                            onSelect({ providerId: m.providerId, model: m.model, reasoning: m.reasoning });
                            useUiStore.getState().setSelectedContextWindow(m.contextWindow);
                            setOpen(false);
                          }}
                        >
                          <span className="flex-1 truncate">{m.model}</span>
                          {m.reasoning && (
                            <Badge variant="primary">思考</Badge>
                          )}
                          <span className="shrink-0 text-[10px] font-mono tabular-nums
                                           text-[var(--ema-text-tertiary)]">
                            {fmtCtx(m.contextWindow)}
                          </span>
                          {isSelected && (
                            <span className="i-mdi:check text-[var(--ema-primary)] text-[10px] shrink-0" aria-hidden />
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </ScrollArea>
          </div>
        </>
      )}
    </div>
  );
}
