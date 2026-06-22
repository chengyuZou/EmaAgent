/**
 * LlmModelManager — the model list shown under a provider's LLM config.
 *
 * Lists models the provider exposes (live /v1/models or static defaults), each
 * with its context window + an enable/disable toggle. Enabled models feed the
 * binding picker. A manual-add box (with token-table autocomplete) covers
 * models the live list misses.
 *
 * Context window is mandatory: enabling a model whose window is unknown forces
 * the user to type one first (memory budgeting depends on it).
 */
import { useState, useEffect, useCallback, type JSX } from 'react';
import { Badge, Button, Callout, Divider, Input, Spinner, Switch } from '@ema-agent/ui';
import { providersApi, type AvailableModelWire } from '../api/providers.js';
import { showToast } from '../lib/toast.js';

export function LlmModelManager({ providerId }: { providerId: string }): JSX.Element {
  const [models, setModels]   = useState<AvailableModelWire[]>([]);
  const [source, setSource]   = useState<'live' | 'static'>('static');
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  // Inline "enter context window" editor for a model whose window is unknown.
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [pendingCtx,   setPendingCtx]   = useState('');

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
      void disable(m.id);
      return;
    }
    // Enabling: context window required.
    if (m.contextWindow != null) {
      void enable(m.id, m.contextWindow, 'table');
    } else {
      // Unknown window (not in models.dev catalog either) → ask the user.
      setPendingModel(m.id);
      setPendingCtx('');
    }
  }

  async function disable(model: string): Promise<void> {
    if (!confirm(`禁用 "${model}"？所有使用它的模块绑定（Chat / Agent 等）也会一并解除。`)) return;
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
      showToast('请填写有效的上下文窗口（正整数 token 数）', { variant: 'danger' });
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
          <h3 className="text-sm font-medium text-neutral-200">模型</h3>
          <p className="text-xs text-neutral-500 mt-0.5">
            启用的模型才能在「模型绑定」里分配给 Chat、Agent 等模块。
            {source === 'static' && '（显示内置推荐）'}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <span className="i-solar:refresh-linear text-base" aria-hidden />
        </Button>
      </div>

      {/* 搜索框 */}
      <div className="relative">
        <span className="i-solar:magnifer-linear absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 text-sm" aria-hidden />
        <input
          className="w-full bg-neutral-900/80 backdrop-blur-sm border border-neutral-800 rounded-lg pl-8 pr-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-pink-400/40 transition-all duration-250"
          placeholder="搜索模型…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {error && <Callout variant="danger">{error}</Callout>}
      {loading && <div className="flex justify-center py-6"><Spinner size="md" /></div>}

      {!loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {filtered.map((m) => (
            <div key={m.id}>
              <div className="flex items-center justify-between bg-neutral-900/80 backdrop-blur-sm rounded-xl px-3 py-2.5 border border-neutral-800/40 hover:border-neutral-700/40 active:scale-[0.98] transition-all duration-250">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="text-sm text-neutral-200 font-mono truncate">{m.id}</span>
                  {m.contextWindow != null && (
                    <Badge variant="neutral">{(m.contextWindow / 1000).toFixed(0)}K ctx</Badge>
                  )}
                </div>
                <Switch checked={m.enabled} label={m.id} onCheckedChange={() => handleToggle(m)} />
              </div>

              {pendingModel === m.id && (
                <div className="flex items-center gap-2 mt-1.5 px-1">
                  <span className="text-xs text-neutral-400 shrink-0">上下文窗口 (token)</span>
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
            </div>
          ))}
        </div>
      )}

      <ManualAddModel
        onAdd={(model, ctx) => void enable(model, ctx, 'manual')}
        existing={models.map((m) => m.id)}
        available={models}
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

  // Autocomplete from the provider's fetched list (live /models + models.dev
  // catalog context), not a bundled static table.
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
      <p className="text-xs text-neutral-500 mb-1.5">手动添加模型（列表里没有的）</p>
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
              // Auto-fill context from the provider's fetched list (live + models.dev catalog).
              const hit = available.find((m) => m.id === v);
              if (hit?.contextWindow != null) setCtx(String(hit.contextWindow));
            }}
          />
          {suggestions.length > 0 && (
            <div className="absolute z-20 left-0 right-0 top-full mt-1 bg-neutral-900/95 backdrop-blur-md border border-neutral-700/50 rounded-lg shadow-xl overflow-hidden">
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-neutral-800/70 transition-colors"
                  onClick={() => pick(s.id, s.contextWindow)}
                >
                  <span className="text-sm font-mono">{highlight(s.id, query.trim())}</span>
                  <span className="text-xs text-neutral-500">{(s.contextWindow / 1000).toFixed(0)}K</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <input
          type="number"
          className="w-28 bg-neutral-900/80 backdrop-blur-sm border border-neutral-800 rounded-lg px-3 py-1.5 text-sm text-neutral-200 focus:outline-none focus:border-pink-400/40 transition-all duration-250 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          placeholder="窗口 token"
          value={ctx}
          onChange={(e) => setCtx(e.target.value)}
        />
        <Button variant="secondary" size="sm" onClick={add}>添加</Button>
      </div>
    </div>
  );
}

/** Highlight the matched substring in pink-white + violet (brand palette). */
function highlight(text: string, query: string): JSX.Element {
  const q = query.toLowerCase();
  const idx = text.toLowerCase().indexOf(q);
  if (!q || idx === -1) return <span className="text-neutral-300">{text}</span>;
  return (
    <span className="text-neutral-300">
      {text.slice(0, idx)}
      <span className="text-pink-200 bg-violet-500/25 rounded px-0.5">{text.slice(idx, idx + q.length)}</span>
      {text.slice(idx + q.length)}
    </span>
  );
}
