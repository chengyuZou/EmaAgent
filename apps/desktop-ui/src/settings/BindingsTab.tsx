/**
 * BindingsTab — grid of module cards → detail view per module (AIRI-style).
 *
 * Level 1: 2-column card grid (one card per BindingModule).
 * Level 2: single-select — provider cards (horizontal scroll) → model grid (2-col).
 */
import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  modelBindingsApi,
  type BindingModule,
  type ResolvedModelBinding,
  type AvailableBindingModel,
} from '../api/model-bindings.js';
import { useSettingsStore } from '../stores/settings-store.js';
import { showToast } from '../lib/toast.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MODULE_CAPABILITY: Record<BindingModule, string> = {
  chat:           'llm',
  narrative:      'llm',
  agent:          'llm',
  compaction:     'llm',
  emotion:        'llm',
  memory:         'llm',
  router:         'llm',
  'plan-parse':   'llm',
  title:          'llm',
  'lightrag-llm': 'llm',
  embed:          'embed',
  rerank:         'rerank',
  tts:            'tts',
  stt:            'stt',
  vision:         'vision',
  imagegen:       'vision',
};

const POOL_CAPABILITIES = new Set(['llm', 'embed', 'rerank', 'tts', 'stt']);

const MODULES: Array<{ id: BindingModule; label: string }> = [
  { id: 'chat',          label: 'Chat' },
  { id: 'narrative',     label: 'Narrative' },
  { id: 'agent',         label: 'Agent' },
  { id: 'compaction',    label: 'Compaction' },
  { id: 'emotion',       label: 'Emotion' },
  { id: 'memory',        label: 'Memory' },
  { id: 'router',        label: 'Router' },
  { id: 'plan-parse',    label: 'Plan Parse' },
  { id: 'title',         label: 'Title' },
  { id: 'embed',         label: 'Embed' },
  { id: 'rerank',        label: 'Rerank' },
  { id: 'lightrag-llm',  label: 'LightRAG LLM' },
  { id: 'tts',           label: 'TTS' },
  { id: 'stt',           label: 'STT' },
  { id: 'vision',        label: 'Vision' },
  { id: 'imagegen',      label: 'Image Gen' },
];

const CAP_LABELS: Record<string, string> = {
  llm: 'LLM', embed: 'Embed', rerank: 'Rerank', tts: 'TTS', stt: 'STT', vision: 'Vision',
};

// ── Sub-components ────────────────────────────────────────────────────────────

/** Horizontal-scroll provider card row (AIRI RadioCardSimple style). */
function ProviderCardRow({
  providerIds,
  providerName,
  selectedId,
  onSelect,
}: {
  providerIds: string[];
  providerName: (id: string) => string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-row gap-4 overflow-x-auto pb-1">
      {providerIds.map((pcId) => {
        const isSel = selectedId === pcId;
        return (
          <button
            key={pcId}
            className={`flex-shrink-0 rounded-xl p-4 min-w-[180px] text-left border-2
                        active:scale-[0.98] transition-all duration-250 ease-in-out ${
              isSel
                ? 'bg-pink-400/10 border-pink-400/40 shadow-lg'
                : 'bg-neutral-900/80 backdrop-blur-sm border-neutral-800/40 hover:border-pink-400/30 hover:bg-neutral-900/95'
            }`}
            onClick={() => onSelect(pcId)}
          >
            {/* Radio dot */}
            <div className="flex items-center gap-2 mb-2">
              <span
                className={`size-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                  isSel ? 'border-pink-400' : 'border-neutral-600'
                }`}
              >
                {isSel && <span className="size-2 rounded-full bg-pink-400" />}
              </span>
              <span className={`text-sm font-medium truncate ${isSel ? 'text-pink-200' : 'text-neutral-300'}`}>
                {providerName(pcId)}
              </span>
            </div>
            <p className="text-xs text-neutral-500 truncate">
              {isSel ? '已选择' : '点击选择'}
            </p>
          </button>
        );
      })}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function BindingsTab(): JSX.Element {
  const [view, setView] = useState<'grid' | 'detail'>('grid');
  const [activeModule, setActiveModule] = useState<BindingModule>('chat');
  const [bindings, setBindings] = useState<ResolvedModelBinding[]>([]);
  const [pool, setPool] = useState<AvailableBindingModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  // Detail-only state
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const allProviders = useSettingsStore((s) => s.providers);
  const requiredCap = MODULE_CAPABILITY[activeModule];
  const hasPool = POOL_CAPABILITIES.has(requiredCap);

  // provider display-name lookup
  const providerNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of allProviders) m.set(p.id, p.displayName);
    for (const pm of pool) m.set(pm.providerConfigId, pm.providerName);
    return m;
  }, [allProviders, pool]);

  const providerName = useCallback((pcId: string) => providerNames.get(pcId) ?? pcId, [providerNames]);

  // Providers that have enabled models in the pool
  const poolProviderIds = useMemo(
    () => [...new Set(pool.map((m) => m.providerConfigId))],
    [pool],
  );

  // ── Load data ──────────────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    void modelBindingsApi.listByModule(activeModule)
      .then(setBindings)
      .catch(() => setBindings([]))
      .finally(() => setLoading(false));

    if (hasPool) {
      void modelBindingsApi.listAvailable(requiredCap)
        .then((p) => {
          setPool(p);
          // Auto-select first provider if none selected
          const ids = [...new Set(p.map((m) => m.providerConfigId))];
          setSelectedProviderId((prev) => prev && ids.includes(prev) ? prev : (ids[0] ?? null));
        })
        .catch(() => setPool([]));
    } else {
      setPool([]);
      setSelectedProviderId(null);
    }
    setSearchQuery('');
  }, [activeModule, requiredCap, hasPool]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const goDetail = useCallback((mod: BindingModule) => {
    setActiveModule(mod);
    setView('detail');
    setSelectedProviderId(null);
    setSearchQuery('');
  }, []);

  const goGrid = useCallback(() => setView('grid'), []);

  // Single-select atomic set (delete old + create new)
  const handleSelect = useCallback(async (pcId: string, model: string) => {
    const key = `${pcId}|${model}`;
    setSavingKey(key);
    try {
      const updated = await modelBindingsApi.set(activeModule, {
        providerConfigId: pcId,
        model,
      });
      setBindings(updated);
      showToast('已绑定', { variant: 'success' });
    } catch (err: unknown) {
      showToast(`绑定失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    } finally {
      setSavingKey(null);
    }
  }, [activeModule]);

  const handleUnbind = useCallback(async () => {
    const b = bindings[0];
    if (!b) return;
    try {
      await modelBindingsApi.delete(activeModule, b.providerConfigId, b.model);
      const updated = await modelBindingsApi.listByModule(activeModule);
      setBindings(updated);
      showToast('已解绑', { variant: 'success' });
    } catch (err: unknown) {
      showToast(`解绑失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    }
  }, [activeModule, bindings]);

  // ── Filtered models ────────────────────────────────────────────────────────
  const visibleModels = useMemo(() => {
    let list = pool;
    if (selectedProviderId) list = list.filter((m) => m.providerConfigId === selectedProviderId);
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((m) => m.model.toLowerCase().includes(q));
    }
    return list;
  }, [pool, selectedProviderId, searchQuery]);

  // Bound model key (single-select → at most one)
  const boundKey = bindings[0] ? `${bindings[0].providerConfigId}|${bindings[0].model}` : null;

  // ── Grid view ──────────────────────────────────────────────────────────────
  if (view === 'grid') {
    return (
      <div className="flex flex-col gap-6 overflow-y-auto min-h-0">
        <div>
          <h2 className="text-2xl text-neutral-500">模型绑定</h2>
          <p className="text-neutral-400 text-sm mt-1">
            为每个模块选择要使用的模型。先在"服务来源"启用模型，再在此绑定。
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {MODULES.map((m, i) => {
            const cap = MODULE_CAPABILITY[m.id];
            return (
              <button
                key={m.id}
                style={{ animationDelay: `${i * 35}ms` }}
                className="bg-neutral-900/80 backdrop-blur-sm border border-neutral-800/40 rounded-2xl p-5 text-left
                           hover:border-primary-400/30 hover:bg-neutral-900/95 hover:shadow-lg
                           active:scale-[0.98] transition-all duration-250 ease-in-out animate-slide-up"
                onClick={() => goDetail(m.id)}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-base font-medium text-neutral-200 group-hover:text-primary-300">{m.label}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-neutral-800/60 text-neutral-400 uppercase tracking-wide">
                    {CAP_LABELS[cap] ?? cap}
                  </span>
                </div>
                <p className="text-xs text-neutral-500">点击配置 →</p>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Detail view ────────────────────────────────────────────────────────────
  const moduleLabel = MODULES.find((m) => m.id === activeModule)?.label ?? activeModule;
  const cap = MODULE_CAPABILITY[activeModule];
  const currentBinding = bindings[0] ?? null;

  return (
    <div className="flex flex-col gap-6 overflow-y-auto min-h-0 animate-slide-right">
      {/* Header */}
      <div className="flex items-center gap-4">
        <button
          className="size-9 flex items-center justify-center rounded-full bg-neutral-800 text-neutral-400
                     hover:bg-neutral-700 hover:text-neutral-200
                     active:scale-90 transition-all duration-150"
          onClick={goGrid}
        >
          <span className="i-solar:alt-arrow-left-linear w-5 h-5" />
        </button>
        <div>
          <h2 className="text-2xl text-neutral-500">{moduleLabel} 绑定
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 ml-2 align-middle uppercase">
              {CAP_LABELS[cap] ?? cap}
            </span>
          </h2>
        </div>
      </div>

      {loading ? (
        <div className="text-neutral-500 text-sm">加载中…</div>
      ) : (
        <>
          {/* ── Current binding ──────────────────────────────────────────── */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm text-neutral-400">已绑定</h3>
            {currentBinding ? (
              <div className="flex items-center justify-between bg-pink-400/10 border-2 border-pink-400/40 rounded-xl px-4 py-3">
                <div className="flex items-center gap-2 text-sm min-w-0">
                  <span className="text-neutral-300 truncate">{providerName(currentBinding.providerConfigId)}</span>
                  <span className="text-neutral-500 flex-shrink-0">/</span>
                  <span className="font-mono text-pink-300 truncate">{currentBinding.model}</span>
                </div>
                <button
                  className="flex-shrink-0 px-2.5 py-1 rounded-lg text-xs bg-red-500/15 text-red-300 hover:bg-red-500/25 transition-colors ml-3"
                  onClick={handleUnbind}
                >
                  解绑
                </button>
              </div>
            ) : (
              <p className="text-neutral-500 text-sm">暂无绑定，请从下方选择</p>
            )}
          </section>

          {/* ── Pool area ────────────────────────────────────────────────── */}
          {!hasPool ? (
            <p className="text-neutral-500 text-sm">
              {cap === 'vision' ? 'Vision 模型暂不支持启用池。' : '此能力暂不支持启用池。'}
            </p>
          ) : pool.length === 0 ? (
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-6 text-center">
              <p className="text-neutral-400 text-sm">尚无已启用的 {CAP_LABELS[cap] ?? cap} 模型</p>
              <p className="text-neutral-500 text-xs mt-1">
                请先到"服务来源"打开对应能力的 provider，启用要用的模型。
              </p>
            </div>
          ) : (
            <>
              {/* Provider cards */}
              <section className="flex flex-col gap-3">
                <h3 className="text-sm text-neutral-400">服务来源</h3>
                <ProviderCardRow
                  providerIds={poolProviderIds}
                  providerName={providerName}
                  selectedId={selectedProviderId}
                  onSelect={setSelectedProviderId}
                />
              </section>

              {/* Model grid with search */}
              <section className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm text-neutral-400">模型</h3>
                  <span className="text-[10px] text-neutral-600">{visibleModels.length} 个</span>
                </div>

                {/* Search (AIRI style) */}
                <div className="relative w-full">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 i-solar:magnifer-line-duotone w-4 h-4 text-neutral-500" />
                  <input
                    className="w-full rounded-xl border-2 border-neutral-800 bg-neutral-900 py-2.5 pl-10 pr-4 text-sm text-neutral-200
                               placeholder:text-neutral-600 focus:outline-none focus:border-pink-400/40 transition-colors"
                    placeholder="搜索模型..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>

                {/* 2-column model grid (AIRI RadioCardDetail style) */}
                <div className="grid grid-cols-2 gap-3">
                  {visibleModels.map((m) => {
                    const key = `${m.providerConfigId}|${m.model}`;
                    const isBound = boundKey === key;
                    const isSaving = savingKey === key;

                    return (
                      <button
                        key={key}
                        disabled={isBound || isSaving}
                        className={`rounded-xl p-3.5 text-left border-2 transition-colors ${
                          isBound
                            ? 'bg-pink-400/10 border-pink-400/40'
                            : 'bg-neutral-900/60 border-neutral-800 hover:border-pink-400/30'
                        } disabled:cursor-default`}
                        onClick={() => handleSelect(m.providerConfigId, m.model)}
                      >
                        <div className="flex items-start gap-2.5">
                          {/* Radio dot */}
                          <span
                            className={`mt-0.5 size-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                              isBound ? 'border-pink-400' : 'border-neutral-600'
                            }`}
                          >
                            {isBound && <span className="size-2 rounded-full bg-pink-400" />}
                          </span>
                          <div className="min-w-0 flex flex-col gap-0.5">
                            <span className={`text-sm truncate ${isBound ? 'text-pink-200' : 'text-neutral-200'}`}>
                              {m.model}
                            </span>
                            <span className="text-xs text-neutral-500">
                              {m.contextWindow > 0 && `${(m.contextWindow / 1000).toFixed(0)}K`}
                              {m.dim !== undefined && m.dim > 0 && ` · ${m.dim}d`}
                              {isSaving && ' · 保存中…'}
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {visibleModels.length === 0 && searchQuery && (
                  <p className="text-neutral-500 text-sm text-center py-4">未找到匹配的模型</p>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
