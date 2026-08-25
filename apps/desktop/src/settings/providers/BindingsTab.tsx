/**
 * BindingsTab — grid of module cards → detail view per module (AIRI-style).
 *
 * Level 1: 2-column card grid (one card per BindingModule).
 * Level 2: single-select — provider cards (horizontal scroll) → model grid (2-col).
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Button,
  CardButton,
  IconButton,
  Input,
  Callout,
  RadioDot,
  resolveProviderIconClass,
} from '@ema-agent/ui';
import {
  modelBindingsApi,
  type BindingModule,
  type ResolvedModelBinding,
  type AvailableBindingModel,
} from '../../api/model-bindings.js';
import { providersApi, type ProviderDefinition } from '../../api/providers.js';
import { useSettingsStore } from '../../stores/settings-store.js';
import { showToast } from '../../lib/toast.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MODULE_CAPABILITY: Record<BindingModule, string> = {
  memory:           'llm',
  title:            'llm',
  'lightrag-llm':   'llm',
  'lightrag-embed': 'embed',
  tts:              'tts',
  stt:              'stt',
  vision:           'vision',
  // V1 暂不展示 Image Gen，但保留真实能力名，禁止再次伪装成 Vision。
  imagegen:         'imagegen',
};

const POOL_CAPABILITIES = new Set(['llm', 'embed', 'rerank', 'tts', 'stt', 'vision']);

const MODULES: Array<{ id: BindingModule; label: string; desc: string }> = [
  { id: 'memory',        label: 'Memory',       desc: '记忆提取与整合' },
  { id: 'title',          label: 'Title',         desc: '会话标题自动生成' },
  { id: 'lightrag-embed', label: 'LightRAG 嵌入', desc: '⚠️ 叙事专用嵌入（bge-m3）。换模型会让 narrative 检索骤减、需重建索引——非必要勿动。知识库的嵌入在「设置 → 知识库」单独选。' },
  { id: 'lightrag-llm',   label: 'LightRAG LLM',  desc: '叙事模式剧情检索 LLM' },
  { id: 'tts',           label: 'TTS',          desc: '语音合成' },
  { id: 'stt',           label: 'STT',          desc: '语音识别' },
  { id: 'vision',        label: 'Vision',       desc: '图像理解' },
  // V1 暂不开放：Image Gen 的模型池、探测与执行链尚未完成端到端验收。
  // { id: 'imagegen', label: 'Image Gen', desc: '图像生成' },
];

const CAP_LABELS: Record<string, string> = {
  llm: 'LLM', embed: 'Embed', rerank: 'Rerank', tts: 'TTS', stt: 'STT', vision: 'Vision',
};

// Capability icons — mirror the ProvidersTab section icons.
const CAP_ICON: Record<string, string> = {
  llm:      'i-solar:chat-square-like-bold-duotone',
  embed:    'i-solar:structure-bold-duotone',
  rerank:   'i-solar:sort-from-top-to-bottom-bold-duotone',
  tts:      'i-solar:user-speak-rounded-bold-duotone',
  stt:      'i-solar:microphone-3-bold-duotone',
  vision:   'i-solar:eye-bold-duotone',
  imagegen: 'i-solar:gallery-bold-duotone',
};

// ── Sub-components ────────────────────────────────────────────────────────────

/** Horizontal-scroll provider card row (AIRI RadioCardSimple style). */
function ProviderCardRow({
  providerIds,
  providerName,
  providerIcon,
  selectedId,
  onSelect,
}: {
  providerIds: string[];
  providerName: (id: string) => string;
  providerIcon?: (id: string) => string | undefined;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-row gap-4 overflow-x-auto pb-1">
      {providerIds.map((pcId) => {
        const isSel = selectedId === pcId;
        const logo = providerIcon?.(pcId);
        return (
          <CardButton
            key={pcId}
            selected={isSel}
            padding="md"
            className={`group flex-shrink-0 rounded-xl border-2 min-w-[180px] ema-glass-weak ema-card-decorate ema-card-decorate--plus hover:border-[var(--ema-primary)] ${isSel ? 'shadow-[var(--ema-shadow-2)]' : 'hover:shadow-[var(--ema-shadow-2)]'}`}
            onClick={() => onSelect(pcId)}
          >
            {/* Radio dot */}
            <div className="flex items-center gap-2 mb-2">
              <RadioDot selected={isSel} />
              <span className={`text-sm font-medium truncate ${
                isSel ? 'text-[var(--ema-primary-text)]' : 'text-[var(--ema-text-secondary)]'
              }`}>
                {providerName(pcId)}
              </span>
            </div>
            <p className="text-xs text-[var(--ema-text-tertiary)] truncate">
              {isSel ? '已选择' : '点击选择'}
            </p>
            {logo && (
              <span
                className={`absolute right-3 top-1/2 -translate-y-1/2 size-6 opacity-30 group-hover:opacity-60 transition-opacity ${logo}`}
                aria-hidden
              />
            )}
          </CardButton>
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
  const [boundModules, setBoundModules] = useState<Set<BindingModule>>(new Set());
  const [pool, setPool] = useState<AvailableBindingModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  // Detail-only state
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const allProviders = useSettingsStore((s) => s.providers);
  const requiredCap = MODULE_CAPABILITY[activeModule];
  const hasPool = POOL_CAPABILITIES.has(requiredCap);

  // provider definition iconKey lookup (for logo peek on cards)
  const [definitions, setDefinitions] = useState<ProviderDefinition[]>([]);
  useEffect(() => { void providersApi.listDefinitions().then(setDefinitions).catch(() => {}); }, []);
  const iconKeyFor = useCallback((pcId: string): string | undefined => {
    const p = allProviders.find((x) => x.id === pcId);
    const def = definitions.find((d) => d.id === p?.definitionId);
    return def ? resolveProviderIconClass(def.branding.iconId) : undefined;
  }, [allProviders, definitions]);

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

  // Bound-status across all modules — drives the grid card status dots.
  const refreshBoundModules = useCallback(() => {
    void modelBindingsApi.list()
      .then((all) => setBoundModules(new Set(all.map((b) => b.module))))
      .catch(() => { /* leave as-is */ });
  }, []);

  useEffect(() => { refreshBoundModules(); }, [refreshBoundModules]);

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
      refreshBoundModules();
      showToast('已绑定', { variant: 'success' });
    } catch (err: unknown) {
      showToast(`绑定失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    } finally {
      setSavingKey(null);
    }
  }, [activeModule, refreshBoundModules]);

  const handleUnbind = useCallback(async () => {
    const b = bindings[0];
    if (!b) return;
    try {
      await modelBindingsApi.delete(activeModule, b.providerConfigId, b.model);
      const updated = await modelBindingsApi.listByModule(activeModule);
      setBindings(updated);
      refreshBoundModules();
      showToast('已解绑', { variant: 'success' });
    } catch (err: unknown) {
      showToast(`解绑失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    }
  }, [activeModule, bindings, refreshBoundModules]);

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
      <div className="flex flex-col gap-6">
        <div>
          <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">模型绑定</h2>
          <p className="text-[var(--ema-text-tertiary)] text-xs mt-1">
            为每个模块选择要使用的模型。先在"服务来源"启用模型，再在此绑定。
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {MODULES.map((m, i) => {
            const cap = MODULE_CAPABILITY[m.id];
            const isBound = boundModules.has(m.id);
            return (
              <CardButton
                key={m.id}
                padding="md"
                className="relative rounded-2xl ema-glass-weak hover:border-[var(--ema-primary)] hover:shadow-[var(--ema-shadow-2)] ema-stagger-in ema-card-decorate ema-card-decorate--plus"
                style={{ '--stagger-i': i } as React.CSSProperties}
                onClick={() => goDetail(m.id)}
              >
                {/* Bound status dot (top-right) — mirrors the provider card dot */}
                {isBound && (
                  <span
                    className="absolute top-3 right-3 size-2 rounded-full bg-[var(--ema-success)]"
                    aria-hidden
                  />
                )}
                <div className="flex items-center gap-2.5 mb-1.5">
                  <span
                    className={`${CAP_ICON[cap] ?? 'i-solar:box-bold-duotone'} text-2xl shrink-0 text-[var(--ema-text-tertiary)]`}
                    aria-hidden
                  />
                  <span className="text-base font-semibold text-[var(--ema-text-primary)] truncate">{m.label}</span>
                </div>
                <p className="text-xs text-[var(--ema-text-tertiary)] line-clamp-2">{m.desc}</p>
              </CardButton>
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
    <div className="flex flex-col gap-6 ema-slide-right">
      {/* Header */}
      <div className="flex items-center gap-4">
        <IconButton
          label="返回模型绑定"
          icon="i-solar:alt-arrow-left-linear"
          size="md"
          onClick={goGrid}
        />
        <div>
          <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">{moduleLabel} 绑定
            <span className="text-[10px] px-2 py-0.5 rounded-full
                             bg-[var(--ema-surface-2)] text-[var(--ema-text-tertiary)]
                             ml-2 align-middle uppercase">
              {CAP_LABELS[cap] ?? cap}
            </span>
          </h2>
        </div>
      </div>

      {activeModule === 'lightrag-embed' && (
        <Callout variant="warn" className="text-xs leading-relaxed ema-slide-up">
          这是 <b>叙事模式（narrative）专用</b>的嵌入模型，默认 <b>bge-m3</b>。知识库用的是另一套（设置 → 知识库 → 模型）。
          换这里的模型会让已建好的 LightRAG 剧情索引与新查询<b>错配、检索质量骤减</b>，且需要重建 LightRAG 索引——非必要请勿改动。
        </Callout>
      )}

      {loading ? (
        <div className="text-[var(--ema-text-tertiary)] text-sm">加载中…</div>
      ) : (
        <>
          {/* ── Current binding ──────────────────────────────────────────── */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm text-[var(--ema-text-tertiary)]">已绑定</h3>
            {currentBinding ? (
              <div className="relative flex items-center justify-between
                              bg-[var(--ema-primary-muted)] border-2 border-[var(--ema-primary)]
                              rounded-xl px-4 py-3 ema-card-decorate ema-card-decorate--plus">
                <span
                  className="absolute top-2 right-2 size-2 rounded-full bg-[var(--ema-success)]"
                  aria-hidden
                />
                <div className="flex items-center gap-2 text-sm min-w-0">
                  <span className={`${CAP_ICON[cap] ?? 'i-solar:box-bold-duotone'} text-lg shrink-0 text-[var(--ema-text-tertiary)]`} aria-hidden />
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
            <p className="text-[var(--ema-text-tertiary)] text-sm">此能力暂不支持启用池。</p>
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
                  providerIcon={iconKeyFor}
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
                    const logo = iconKeyFor(m.providerConfigId);

                    return (
                      <CardButton
                        key={key}
                        selected={isBound}
                        disabled={isBound || isSaving}
                        padding="sm"
                        className={`group rounded-xl border-2 disabled:cursor-default ema-card-decorate ema-card-decorate--plus`}
                        onClick={() => handleSelect(m.providerConfigId, m.model)}
                      >
                        <div className="flex items-start gap-2.5">
                          {/* Radio dot */}
                          <RadioDot selected={isBound} className="mt-0.5" />
                          <div className="min-w-0 flex flex-col gap-0.5">
                            <span className={`text-sm truncate ${
                              isBound ? 'text-[var(--ema-primary-text)]' : 'text-[var(--ema-text-primary)]'
                            }`}>
                              {m.model}
                            </span>
                            <span className="text-xs text-[var(--ema-text-tertiary)]">
                              {m.contextWindow > 0 && (m.contextWindow >= 1000000 ? `${(m.contextWindow / 1000000).toFixed(0)}M` : `${(m.contextWindow / 1000).toFixed(0)}K`)}
                              {m.dim !== undefined && m.dim > 0 && ` · ${m.dim}d`}
                              {isSaving && ' · 保存中…'}
                            </span>
                          </div>
                        </div>
                        {logo && (
                          <span
                            className={`absolute right-2 top-1/2 -translate-y-1/2 size-5 opacity-25 group-hover:opacity-60 transition-opacity ${logo}`}
                            aria-hidden
                          />
                        )}
                      </CardButton>
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
