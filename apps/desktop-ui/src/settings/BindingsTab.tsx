/**
 * BindingsTab — grid of module cards → detail view per module (AIRI-style).
 *
 * Level 1: 2-column card grid (one card per BindingModule).
 * Level 2: single-select — provider cards (horizontal scroll) → model grid (2-col).
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Button, IconButton, Input } from '@ema-agent/ui';
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
                        active:scale-[0.98] transition-all duration-[var(--ema-duration-base)] ${
              isSel
                ? 'bg-[var(--ema-primary-muted)] border-[var(--ema-primary)] shadow-[var(--ema-shadow-2)]'
                : 'bg-[var(--ema-surface-1)] ema-glass-weak border-[var(--ema-border)] hover:border-[var(--ema-primary)] hover:bg-[var(--ema-surface-2)]'
            }`}
            onClick={() => onSelect(pcId)}
          >
            {/* Radio dot */}
            <div className="flex items-center gap-2 mb-2">
              <span
                className={`size-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                  isSel ? 'border-[var(--ema-primary)]' : 'border-[var(--ema-border-strong)]'
                }`}
              >
                {isSel && <span className="size-2 rounded-full bg-[var(--ema-primary)]" />}
              </span>
              <span className={`text-sm font-medium truncate ${
                isSel ? 'text-[var(--ema-primary-text)]' : 'text-[var(--ema-text-secondary)]'
              }`}>
                {providerName(pcId)}
              </span>
            </div>
            <p className="text-xs text-[var(--ema-text-tertiary)] truncate">
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
  const [activeModule, setActiveModule] = useState<BindingModule>('memory');
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

  const boundKey = bindings[0] ? `${bindings[0].providerConfigId}|${bindings[0].model}` : null;

  // ── Grid view ──────────────────────────────────────────────────────────────
  if (view === 'grid') {
    return (
      <div className="flex flex-col gap-6 overflow-y-auto min-h-0">
        <div>
          <h2 className="text-2xl text-[var(--ema-text-tertiary)]">模型绑定</h2>
          <p className="text-[var(--ema-text-tertiary)] text-sm mt-1">
            为每个模块选择要使用的模型。先在"服务来源"启用模型，再在此绑定。
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {MODULES.map((m, i) => {
            const cap = MODULE_CAPABILITY[m.id];
            return (
              <button
                key={m.id}
                className="bg-[var(--ema-surface-1)] ema-glass-weak border border-[var(--ema-border)]
                           rounded-2xl p-5 text-left
                           hover:border-[var(--ema-primary)] hover:bg-[var(--ema-surface-2)]
                           hover:shadow-[var(--ema-shadow-2)]
                           active:scale-[0.98] transition-all duration-[var(--ema-duration-base)] ema-stagger-in"
                style={{ '--stagger-i': i } as React.CSSProperties}
                onClick={() => goDetail(m.id)}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-base font-medium text-[var(--ema-text-primary)]">{m.label}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full
                                   bg-[var(--ema-surface-3)] text-[var(--ema-text-tertiary)]
                                   uppercase tracking-wide">
                    {CAP_LABELS[cap] ?? cap}
                  </span>
                </div>
                <p className="text-xs text-[var(--ema-text-tertiary)]">点击配置 →</p>
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
    <div className="flex flex-col gap-6 overflow-y-auto min-h-0 ema-slide-right">
      {/* Header */}
      <div className="flex items-center gap-4">
        <IconButton
          label="返回模型绑定"
          icon="i-solar:alt-arrow-left-linear"
          size="md"
          onClick={goGrid}
        />
        <div>
          <h2 className="text-2xl text-[var(--ema-text-tertiary)]">{moduleLabel} 绑定
            <span className="text-[10px] px-2 py-0.5 rounded-full
                             bg-[var(--ema-surface-2)] text-[var(--ema-text-tertiary)]
                             ml-2 align-middle uppercase">
              {CAP_LABELS[cap] ?? cap}
            </span>
          </h2>
        </div>
      </div>

      {loading ? (
        <div className="text-[var(--ema-text-tertiary)] text-sm">加载中…</div>
      ) : (
        <>
          {/* ── Current binding ──────────────────────────────────────────── */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm text-[var(--ema-text-tertiary)]">已绑定</h3>
            {currentBinding ? (
              <div className="flex items-center justify-between
                              bg-[var(--ema-primary-muted)] border-2 border-[var(--ema-primary)]
                              rounded-xl px-4 py-3">
                <div className="flex items-center gap-2 text-sm min-w-0">
                  <span className="text-[var(--ema-text-secondary)] truncate">{providerName(currentBinding.providerConfigId)}</span>
                  <span className="text-[var(--ema-text-tertiary)] flex-shrink-0">/</span>
                  <span className="font-mono text-[var(--ema-primary)] truncate">{currentBinding.model}</span>
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void handleUnbind()}
                  className="flex-shrink-0 ml-3"
                >
                  解绑
                </Button>
              </div>
            ) : (
              <p className="text-[var(--ema-text-tertiary)] text-sm">暂无绑定，请从下方选择</p>
            )}
          </section>

          {/* ── Pool area ────────────────────────────────────────────────── */}
          {!hasPool ? (
            <p className="text-[var(--ema-text-tertiary)] text-sm">
              {cap === 'vision' ? 'Vision 模型暂不支持启用池。' : '此能力暂不支持启用池。'}
            </p>
          ) : pool.length === 0 ? (
            <div className="bg-[var(--ema-surface-1)] border border-[var(--ema-border)] rounded-xl px-4 py-6 text-center">
              <p className="text-[var(--ema-text-tertiary)] text-sm">尚无已启用的 {CAP_LABELS[cap] ?? cap} 模型</p>
              <p className="text-[var(--ema-text-tertiary)] text-xs opacity-70 mt-1">
                请先到"服务来源"打开对应能力的 provider，启用要用的模型。
              </p>
            </div>
          ) : (
            <>
              {/* Provider cards */}
              <section className="flex flex-col gap-3">
                <h3 className="text-sm text-[var(--ema-text-tertiary)]">服务来源</h3>
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
                  <h3 className="text-sm text-[var(--ema-text-tertiary)]">模型</h3>
                  <span className="text-[10px] text-[var(--ema-text-tertiary)] opacity-50">
                    {visibleModels.length} 个
                  </span>
                </div>

                {/* Search */}
                <div className="relative w-full">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2
                                   i-solar:magnifer-line-duotone w-4 h-4
                                   text-[var(--ema-text-tertiary)] pointer-events-none" aria-hidden />
                  <Input
                    className="pl-10"
                    placeholder="搜索模型..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>

                {/* 2-column model grid */}
                <div className="grid grid-cols-2 gap-3">
                  {visibleModels.map((m) => {
                    const key = `${m.providerConfigId}|${m.model}`;
                    const isBound = boundKey === key;
                    const isSaving = savingKey === key;

                    return (
                      <button
                        key={key}
                        disabled={isBound || isSaving}
                        className={`rounded-xl p-3.5 text-left border-2 transition-all
                                    duration-[var(--ema-duration-base)] ${
                          isBound
                            ? 'bg-[var(--ema-primary-muted)] border-[var(--ema-primary)]'
                            : 'bg-[var(--ema-surface-1)] border-[var(--ema-border)] hover:border-[var(--ema-primary)]'
                        } disabled:cursor-default`}
                        onClick={() => handleSelect(m.providerConfigId, m.model)}
                      >
                        <div className="flex items-start gap-2.5">
                          {/* Radio dot */}
                          <span
                            className={`mt-0.5 size-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                              isBound ? 'border-[var(--ema-primary)]' : 'border-[var(--ema-border-strong)]'
                            }`}
                          >
                            {isBound && <span className="size-2 rounded-full bg-[var(--ema-primary)]" />}
                          </span>
                          <div className="min-w-0 flex flex-col gap-0.5">
                            <span className={`text-sm truncate ${
                              isBound ? 'text-[var(--ema-primary-text)]' : 'text-[var(--ema-text-primary)]'
                            }`}>
                              {m.model}
                            </span>
                            <span className="text-xs text-[var(--ema-text-tertiary)]">
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
                  <p className="text-[var(--ema-text-tertiary)] text-sm text-center py-4">未找到匹配的模型</p>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
