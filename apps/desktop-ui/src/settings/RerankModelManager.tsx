import { useState, useEffect, useCallback, type JSX } from 'react';
import { Badge, Button, Callout, Spinner, Switch } from '@ema-agent/ui';
import { providersApi, type AvailableRerankModelWire } from '../api/providers.js';
import { showToast } from '../lib/toast.js';

export function RerankModelManager({ providerId }: { providerId: string }): JSX.Element {
  const [models, setModels]   = useState<AvailableRerankModelWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await providersApi.listRerankModels(providerId);
      setModels(res.models);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => { void load(); }, [load]);

  async function enable(model: string): Promise<void> {
    try {
      await providersApi.enableRerankModel(providerId, model);
      setModels((ms) => ms.map((m) => (m.id === model ? { ...m, enabled: true } : m)));
    } catch (err) {
      showToast(`启用失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  async function disable(model: string): Promise<void> {
    if (!confirm(`禁用 "${model}"？使用它的重排序绑定也会一并解除。`)) return;
    try {
      const res = await providersApi.disableRerankModel(providerId, model);
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
          <h3 className="text-sm font-medium text-[var(--ema-text-primary)]">重排序模型</h3>
          <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">
            启用的模型可在「模型绑定」里分配给 rerank 模块。
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
          {models.length === 0 && (
            <p className="text-xs text-[var(--ema-text-tertiary)] py-2">该供应商暂无内置重排序模型。</p>
          )}
          {models.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between bg-[var(--ema-surface-1)] ema-glass-weak
                         rounded-xl px-3 py-2 border border-[var(--ema-border)]
                         hover:border-[var(--ema-border-hover)] active:scale-[0.98]
                         transition-all duration-[var(--ema-duration-base)]"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm text-[var(--ema-text-primary)] font-mono truncate">{m.id}</span>
                {m.maxChunks != null && <Badge variant="neutral">max {m.maxChunks} chunks</Badge>}
              </div>
              <Switch
                checked={m.enabled}
                label={m.id}
                onCheckedChange={() => void (m.enabled ? disable(m.id) : enable(m.id))}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
