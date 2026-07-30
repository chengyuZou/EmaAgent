/**
 * LlmModelManager — model list under a provider's LLM config.
 */
import { useState, useEffect, useCallback, type JSX } from 'react';
import { Button, Callout, ConfirmDialog, Divider, Input, Spinner } from '@ema-agent/ui';
import { providersApi, type AvailableModelWire } from '../../api/providers.js';
import { showToast } from '../../lib/toast.js';
import { ModelToggleCard } from './ModelToggleCard.js';

export function LlmModelManager({ providerId, iconKey }: { providerId: string; iconKey?: string }): JSX.Element {
  const [models, setModels]   = useState<AvailableModelWire[]>([]);
  const [source, setSource]   = useState<'live' | 'catalog'>('catalog');
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [pendingCtx,   setPendingCtx]   = useState('');
  const [confirmModel, setConfirmModel] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await providersApi.listModels(providerId);
      setModels(res.models);
      setSource(res.source);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => { void load(); }, [load]);

  async function enable(model: string, contextWindow: number, src: 'live' | 'table' | 'manual'): Promise<void> {
    try {
      await providersApi.enableModel(providerId, model, contextWindow, src);
      setModels((ms) => ms.map((m) => (m.id === model ? { ...m, enabled: true, contextWindow } : m)));
    } catch (err) {
      showToast(`启用失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  function handleToggle(m: AvailableModelWire): void {
    if (m.enabled) {
      setConfirmModel(m.id);
      return;
    }
    if (m.contextWindow != null) {
      void enable(m.id, m.contextWindow, 'table');
    } else {
      setPendingModel(m.id);
      setPendingCtx('');
    }
  }

  async function confirmDisable(): Promise<void> {
    if (!confirmModel) return;
    const model = confirmModel;
    setConfirmModel(null);
    try {
      const res = await providersApi.disableModel(providerId, model);
      setModels((ms) => ms.map((m) => (m.id === model ? { ...m, enabled: false } : m)));
      if (res.cascadedBindings > 0) {
        showToast(`已禁用，并解除了 ${res.cascadedBindings} 个绑定`, { variant: 'warning' });
      }
    } catch (err) {
      showToast(`禁用失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  function confirmPendingContext(): void {
    const n = parseInt(pendingCtx, 10);
    if (!pendingModel || !Number.isFinite(n) || n <= 0) {
      showToast('请填写有效的上下文窗口(正整数 token 数)', { variant: 'danger' });
      return;
    }
    void enable(pendingModel, n, 'manual');
    setPendingModel(null);
    setPendingCtx('');
  }

  const [search, setSearch] = useState('');
  const filtered = search.trim()
    ? models.filter((m) => m.id.toLowerCase().includes(search.trim().toLowerCase()))
    : models;

  return (
    <div className="flex flex-col gap-4">
      <Divider />

      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-[var(--ema-text-primary)]">模型</h3>
          <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">
            启用的模型才能在「模型绑定」里分配给 Chat、Agent 等模块。
            {source === 'catalog' && '(显示内置推荐)'}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <span className="i-mdi:refresh text-base" aria-hidden />
        </Button>
      </div>

      <div className="relative">
        <span className="i-mdi:magnify absolute left-3 top-1/2 -translate-y-1/2
                         text-[var(--ema-text-tertiary)] text-sm pointer-events-none" aria-hidden />
        <Input
          className="pl-8"
          placeholder="搜索模型…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {error && <Callout variant="danger">{error}</Callout>}
      {loading && <div className="flex justify-center py-6"><Spinner size="md" /></div>}

      {/* Context-window prompt for models without a known window */}
      {pendingModel && (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--ema-border)]
                        bg-[var(--ema-surface-1)] px-3 py-2">
          <span className="text-xs text-[var(--ema-text-secondary)] shrink-0 font-mono truncate max-w-40" title={pendingModel}>
            {pendingModel}
          </span>
          <span className="text-xs text-[var(--ema-text-tertiary)] shrink-0">上下文窗口 (token)</span>
          <Input
            inputSize="sm"
            type="number"
            placeholder="如 65536"
            value={pendingCtx}
            onChange={(e) => setPendingCtx(e.target.value)}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') confirmPendingContext(); }}
          />
          <Button variant="primary" size="sm" onClick={confirmPendingContext}>确认启用</Button>
          <Button variant="ghost" size="sm" onClick={() => setPendingModel(null)}>取消</Button>
        </div>
      )}

      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {filtered.map((m) => (
            <ModelToggleCard
              key={m.id}
              id={m.id}
              badge={m.contextWindow != null ? (m.contextWindow >= 1000000 ? `${(m.contextWindow / 1000000).toFixed(0)}M` : `${(m.contextWindow / 1000).toFixed(0)}K`) : undefined}
              enabled={m.enabled}
              onToggle={() => handleToggle(m)}
              logo={iconKey}
            />
          ))}
        </div>
      )}

      <ManualAddModel
        onAdd={(model, ctx) => void enable(model, ctx, 'manual')}
        existing={models.map((m) => m.id)}
        available={models}
      />

      <ConfirmDialog
        open={!!confirmModel}
        message={confirmModel ? `禁用 "${confirmModel}"？所有使用它的模块绑定(Chat / Agent 等)也会一并解除。` : ''}
        confirmText="禁用"
        onConfirm={() => void confirmDisable()}
        onCancel={() => setConfirmModel(null)}
      />
    </div>
  );
}

// ── Manual add with catalog-backed autocomplete ───────────────────────────────

function ManualAddModel({ onAdd, existing, available }: {
  onAdd(model: string, contextWindow: number): void;
  existing: string[];
  available: AvailableModelWire[];
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [ctx, setCtx]     = useState('');

  const suggestions = query.trim()
    ? available
        .filter((m) => m.id.toLowerCase().includes(query.toLowerCase().trim()))
        .slice(0, 6)
        .map((m) => ({ id: m.id, contextWindow: m.contextWindow ?? 0 }))
    : [];

  function pick(id: string, contextWindow: number): void {
    setQuery(id);
    setCtx(String(contextWindow));
  }

  function add(): void {
    const model = query.trim();
    const n = parseInt(ctx, 10);
    if (!model) return;
    if (existing.includes(model)) { showToast('该模型已在列表中', { variant: 'warning' }); return; }
    if (!Number.isFinite(n) || n <= 0) { showToast('请填写上下文窗口', { variant: 'danger' }); return; }
    onAdd(model, n);
    setQuery('');
    setCtx('');
  }

  return (
    <div className="mt-1">
      <p className="text-xs text-[var(--ema-text-tertiary)] mb-1.5">手动添加模型(列表里没有的)</p>
      <div className="relative flex gap-2">
        <div className="relative flex-1">
          <Input
            inputSize="sm"
            className="font-mono"
            placeholder="模型 ID，如 deepseek-chat"
            value={query}
            onChange={(e) => {
              const v = e.target.value;
              setQuery(v);
              const hit = available.find((m) => m.id === v);
              if (hit?.contextWindow != null) setCtx(String(hit.contextWindow));
            }}
          />
          {suggestions.length > 0 && (
            <div className="absolute z-20 left-0 right-0 top-full mt-1
                            bg-[var(--ema-surface-4)] ema-glass-base
                            border border-[var(--ema-border)] rounded-lg
                            shadow-[var(--ema-shadow-3)] overflow-hidden">
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 text-left
                             hover:bg-[var(--ema-surface-3)]
                             transition-colors duration-[var(--ema-duration-fast)]"
                  onClick={() => pick(s.id, s.contextWindow)}
                >
                  <span className="text-sm font-mono">{highlight(s.id, query.trim())}</span>
                  <span className="text-xs text-[var(--ema-text-tertiary)]">
                    {s.contextWindow >= 1000000 ? `${(s.contextWindow / 1000000).toFixed(0)}M` : `${(s.contextWindow / 1000).toFixed(0)}K`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <Input
          type="number"
          inputSize="sm"
          className="w-28 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          placeholder="窗口 token"
          value={ctx}
          onChange={(e) => setCtx(e.target.value)}
        />
        <Button variant="secondary" size="sm" onClick={add}>添加</Button>
      </div>
    </div>
  );
}

function highlight(text: string, query: string): JSX.Element {
  const q = query.toLowerCase();
  const idx = text.toLowerCase().indexOf(q);
  if (!q || idx === -1) return <span className="text-[var(--ema-text-secondary)]">{text}</span>;
  return (
    <span className="text-[var(--ema-text-secondary)]">
      {text.slice(0, idx)}
      <span className="text-[var(--ema-primary)] bg-[var(--ema-primary-muted)] rounded px-0.5">
        {text.slice(idx, idx + q.length)}
      </span>
      {text.slice(idx + q.length)}
    </span>
  );
}
