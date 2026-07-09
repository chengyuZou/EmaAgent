import { useState, useEffect, useCallback, type JSX } from 'react';
import { Button, Callout, ConfirmDialog, Input, Spinner } from '@ema-agent/ui';
import { providersApi, type AvailableEmbedModelWire } from '../api/providers.js';
import { showToast } from '../lib/toast.js';
import { ModelToggleCard } from './ModelToggleCard.js';

export function EmbedModelManager({ providerId }: { providerId: string }): JSX.Element {
  const [models, setModels]   = useState<AvailableEmbedModelWire[]>([]);
  const [source, setSource]   = useState<'live' | 'static'>('static');
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [confirmModel, setConfirmModel] = useState<string | null>(null);

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

  async function enable(model: string, dim?: number, src?: 'live' | 'table' | 'manual'): Promise<void> {
    try {
      await providersApi.enableEmbedModel(providerId, model, dim, src);
      await load();
    } catch (err) {
      showToast(`启用失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  function handleToggle(m: AvailableEmbedModelWire): void {
    if (m.enabled) {
      setConfirmModel(m.id);
      return;
    }
    void enable(m.id);
  }

  async function confirmDisable(): Promise<void> {
    if (!confirmModel) return;
    const model = confirmModel;
    setConfirmModel(null);
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

  return (
    <div className="flex flex-col gap-3 mt-2">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-[var(--ema-text-primary)]">嵌入模型</h3>
          <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">
            启用的模型可在「模型绑定」里分配给 embed 模块。
            {source === 'static' && '(显示内置推荐)'}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <span className="i-mdi:refresh text-base" aria-hidden />
        </Button>
      </div>

      {error && <Callout variant="danger">{error}</Callout>}
      {loading && <div className="flex justify-center py-6"><Spinner size="md" /></div>}

      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {models.map((m) => (
            <ModelToggleCard
              key={m.id}
              id={m.id}
              badge={m.dim != null ? `${m.dim}d` : undefined}
              enabled={m.enabled}
              onToggle={() => handleToggle(m)}
            />
          ))}
        </div>
      )}

      <ManualAddEmbedModel
        onAdd={(model, dim) => void enable(model, dim, 'manual')}
        existing={models.map((m) => m.id)}
      />

      <ConfirmDialog
        open={!!confirmModel}
        message={confirmModel ? `禁用 "${confirmModel}"？使用它的嵌入绑定也会一并解除。` : ''}
        confirmText="禁用"
        onConfirm={() => void confirmDisable()}
        onCancel={() => setConfirmModel(null)}
      />
    </div>
  );
}

function ManualAddEmbedModel({ onAdd, existing }: {
  onAdd(model: string, dim?: number): void;
  existing: string[];
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [dim,   setDim]   = useState('');

  function add(): void {
    const model = query.trim();
    if (!model) return;
    if (existing.includes(model)) { showToast('该模型已在列表中', { variant: 'warning' }); return; }
    let n: number | undefined;
    if (dim.trim()) {
      n = parseInt(dim, 10);
      if (!Number.isFinite(n) || n <= 0) { showToast('维度需为正整数(留空则自动探测)', { variant: 'danger' }); return; }
    }
    onAdd(model, n);
    setQuery('');
    setDim('');
  }

  return (
    <div className="mt-1">
      <p className="text-xs text-[var(--ema-text-tertiary)] mb-1.5">手动添加嵌入模型</p>
      <div className="relative flex gap-2">
        <div className="relative flex-1">
          <Input
            inputSize="sm"
            className="font-mono"
            placeholder="模型 ID，如 bge-m3"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Input
          inputSize="sm"
          type="number"
          className="w-28"
          placeholder="维度(可选)"
          value={dim}
          onChange={(e) => setDim(e.target.value)}
        />
        <Button variant="secondary" size="sm" onClick={add}>添加</Button>
      </div>
    </div>
  );
}
