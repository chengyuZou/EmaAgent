import { useState, useEffect, useCallback, type JSX } from 'react';
import { Badge, Button, Callout, Input, Spinner, Switch } from '@ema-agent/ui';
import { suggestEmbedModels, lookupEmbedDim } from '@ema-agent/token';
import { providersApi, type AvailableEmbedModelWire } from '../api/providers.js';
import { showToast } from '../lib/toast.js';

export function EmbedModelManager({ providerId }: { providerId: string }): JSX.Element {
  const [models, setModels]   = useState<AvailableEmbedModelWire[]>([]);
  const [source, setSource]   = useState<'live' | 'static'>('static');
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [pendingDim,   setPendingDim]   = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await providersApi.listEmbedModels(providerId);
      setModels(res.models);
      setSource(res.source);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => { void load(); }, [load]);

  async function enable(model: string, dim: number, src: 'live' | 'table' | 'manual'): Promise<void> {
    try {
      await providersApi.enableEmbedModel(providerId, model, dim, src);
      setModels((ms) => ms.map((m) => (m.id === model ? { ...m, enabled: true, dim } : m)));
    } catch (err) {
      showToast(`启用失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  function handleToggle(m: AvailableEmbedModelWire): void {
    if (m.enabled) {
      void disable(m.id);
      return;
    }
    if (m.dim != null) {
      void enable(m.id, m.dim, 'table');
    } else {
      setPendingModel(m.id);
      setPendingDim(String(lookupEmbedDim(m.id) ?? ''));
    }
  }

  async function disable(model: string): Promise<void> {
    if (!confirm(`禁用 "${model}"？使用它的嵌入绑定也会一并解除。`)) return;
    try {
      const res = await providersApi.disableEmbedModel(providerId, model);
      setModels((ms) => ms.map((m) => (m.id === model ? { ...m, enabled: false } : m)));
      if (res.cascadedBindings > 0) {
        showToast(`已禁用，并解除了 ${res.cascadedBindings} 个绑定`, { variant: 'warning' });
      }
    } catch (err) {
      showToast(`禁用失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  function confirmPendingDim(): void {
    const n = parseInt(pendingDim, 10);
    if (!pendingModel || !Number.isFinite(n) || n <= 0) {
      showToast('请填写有效的向量维度（正整数）', { variant: 'danger' });
      return;
    }
    void enable(pendingModel, n, 'manual');
    setPendingModel(null);
    setPendingDim('');
  }

  const inputCls = 'w-full bg-neutral-900/80 backdrop-blur-sm border border-neutral-800 rounded-xl px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-pink-400/40 transition-all duration-250';

  return (
    <div className="flex flex-col gap-3 mt-2">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-neutral-200">嵌入模型</h3>
          <p className="text-xs text-neutral-500 mt-0.5">
            启用的模型可在「模型绑定」里分配给 embed 模块。
            {source === 'static' && '（显示内置推荐）'}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <span className="i-mdi:refresh text-base" aria-hidden />
        </Button>
      </div>

      {error && <Callout variant="danger">{error}</Callout>}
      {loading && <div className="flex justify-center py-6"><Spinner size="md" /></div>}

      {!loading && (
        <div className="flex flex-col gap-1.5">
          {models.map((m) => (
            <div key={m.id}>
              <div className="flex items-center justify-between bg-neutral-900/80 backdrop-blur-sm rounded-xl px-3 py-2 border border-neutral-800/40 hover:border-neutral-700/40 active:scale-[0.98] transition-all duration-250">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-neutral-200 font-mono truncate">{m.id}</span>
                  {m.dim != null && <Badge variant="neutral">{m.dim}d</Badge>}
                </div>
                <Switch checked={m.enabled} label={m.id} onCheckedChange={() => handleToggle(m)} />
              </div>

              {pendingModel === m.id && (
                <div className="flex items-center gap-2 mt-1.5 pl-3">
                  <span className="text-xs text-neutral-400 shrink-0">向量维度</span>
                  <Input
                    inputSize="sm"
                    type="number"
                    placeholder="如 1536"
                    value={pendingDim}
                    onChange={(e) => setPendingDim(e.target.value)}
                    autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') confirmPendingDim(); }}
                  />
                  <Button variant="primary" size="sm" onClick={confirmPendingDim}>确认启用</Button>
                  <Button variant="ghost" size="sm" onClick={() => setPendingModel(null)}>取消</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ManualAddEmbedModel
        onAdd={(model, dim) => void enable(model, dim, 'manual')}
        existing={models.map((m) => m.id)}
      />
    </div>
  );
}

function ManualAddEmbedModel({ onAdd, existing }: {
  onAdd(model: string, dim: number): void;
  existing: string[];
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [dim,   setDim]   = useState('');

  const suggestions = query.trim() ? suggestEmbedModels(query, 6) : [];

  function pick(id: string, d: number): void {
    setQuery(id);
    setDim(String(d));
  }

  function add(): void {
    const model = query.trim();
    const n = parseInt(dim, 10);
    if (!model) return;
    if (existing.includes(model)) { showToast('该模型已在列表中', { variant: 'warning' }); return; }
    if (!Number.isFinite(n) || n <= 0) { showToast('请填写向量维度', { variant: 'danger' }); return; }
    onAdd(model, n);
    setQuery('');
    setDim('');
  }

  return (
    <div className="mt-1">
      <p className="text-xs text-neutral-500 mb-1.5">手动添加嵌入模型</p>
      <div className="relative flex gap-2">
        <div className="relative flex-1">
          <Input
            inputSize="sm"
            className="font-mono"
            placeholder="模型 ID，如 bge-m3"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              const d = lookupEmbedDim(e.target.value);
              if (d != null) setDim(String(d));
            }}
          />
          {suggestions.length > 0 && (
            <div className="absolute z-20 left-0 right-0 top-full mt-1 bg-neutral-900/95 backdrop-blur-md border border-neutral-700/50 rounded-lg shadow-xl overflow-hidden">
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-neutral-800/70 transition-colors"
                  onClick={() => pick(s.id, s.dim)}
                >
                  <span className="text-sm font-mono text-neutral-300">{s.id}</span>
                  <span className="text-xs text-neutral-500">{s.dim}d</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <Input
          inputSize="sm"
          type="number"
          className="w-24"
          placeholder="维度"
          value={dim}
          onChange={(e) => setDim(e.target.value)}
        />
        <Button variant="secondary" size="sm" onClick={add}>添加</Button>
      </div>
    </div>
  );
}
