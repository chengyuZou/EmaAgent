/**
 * ModelPicker — dropdown for selecting (providerId, model) before sending.
 *
 * Fetches enabled models from GET /api/providers/models on mount.
 * Groups by provider, supports search filtering, pops UPWARD from the
 * bottom toolbar, uses @ema-agent/ui ScrollArea for the model list.
 */
import { useState, useEffect, useMemo, useRef, type JSX } from 'react';
import { ScrollArea } from '@ema-agent/ui';
import { modelsApi, type EnabledModelWire } from '../api/models.js';

export interface ModelSelection {
  providerId: string;
  model:      string;
}

interface ModelPickerProps {
  selected:    ModelSelection | null;
  onSelect(sel: ModelSelection): void;
  onClear():  void;
}

/** Format context window for compact display. */
function fmtCtx(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000)   return `${Math.round(n / 1000)}K`;
  if (n >= 1000)     return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}

export function ModelPicker({ selected, onSelect, onClear }: ModelPickerProps): JSX.Element {
  const [open, setOpen]         = useState(false);
  const [models, setModels]     = useState<EnabledModelWire[]>([]);
  const [search, setSearch]     = useState('');
  const [loading, setLoading]   = useState(true);
  const searchRef               = useRef<HTMLInputElement>(null);

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
      ? models.filter(m =>
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
    return [...map.entries()].sort(([,a], [,b]) =>
      (a[0]?.providerName ?? '').localeCompare(b[0]?.providerName ?? ''),
    );
  }, [models, search]);

  const selectedModel = selected
    ? models.find(m => m.providerId === selected.providerId && m.model === selected.model)
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
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors max-w-48"
        onClick={() => setOpen(!open)}
        title={triggerTitle}
      >
        <span className="text-[10px]">🤖</span>
        <span className="truncate">{triggerLabel}</span>
        <span className="text-[10px] shrink-0">▾</span>
      </button>

      {/* Dropdown — pops UPWARD (bottom-full) since it's in the bottom toolbar */}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          <div className="absolute bottom-full left-0 mb-1 z-50 w-72 max-h-72 flex flex-col rounded-xl bg-gray-850 border border-gray-700 shadow-2xl">
            {/* Search + clear */}
            <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-700/60 shrink-0">
              <input
                ref={searchRef}
                className="flex-1 bg-transparent text-xs text-gray-200 placeholder-gray-500 outline-none"
                placeholder="搜索模型…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape') { setOpen(false); }
                }}
              />
              {selected && (
                <button
                  className="shrink-0 text-[10px] text-gray-500 hover:text-red-400 px-1 transition-colors"
                  onClick={() => { onClear(); setOpen(false); }}
                  title="恢复默认模型"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Model list with ScrollArea */}
            <ScrollArea orientation="vertical" className="flex-1" viewportClassName="py-1">
              {loading ? (
                <div className="px-3 py-6 text-xs text-gray-500 text-center">加载中…</div>
              ) : grouped.length === 0 ? (
                <div className="px-3 py-6 text-xs text-gray-500 text-center">
                  {search ? '无匹配结果' : '暂无已启用的模型'}
                </div>
              ) : (
                grouped.map(([providerId, providerModels]) => (
                  <div key={providerId}>
                    {/* Provider group header */}
                    <div className="px-3 pt-2 pb-0.5 text-[10px] text-gray-500 font-medium uppercase tracking-wider select-none">
                      {providerModels[0]?.providerName ?? providerId}
                    </div>
                    {providerModels.map(m => {
                      const isSelected = selected?.providerId === m.providerId && selected?.model === m.model;
                      return (
                        <button
                          key={`${m.providerId}:${m.model}`}
                          className={
                            'w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs transition-colors' +
                            (isSelected
                              ? ' text-pink-300 bg-pink-400/10'
                              : ' text-gray-300 hover:bg-gray-750')
                          }
                          onClick={() => {
                            onSelect({ providerId: m.providerId, model: m.model });
                            setOpen(false);
                          }}
                        >
                          <span className="flex-1 truncate">{m.model}</span>
                          <span className="shrink-0 text-[10px] text-gray-500 font-mono tabular-nums">
                            {fmtCtx(m.contextWindow)}
                          </span>
                          {isSelected && <span className="text-pink-400 text-[10px] shrink-0">✓</span>}
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
