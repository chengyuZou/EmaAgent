import { useState, useEffect, useCallback, type JSX } from 'react';
import { Button, Callout, Spinner, Switch } from '@ema-agent/ui';
import { providersApi, type AvailableSimpleModelWire } from '../api/providers.js';
import { showToast } from '../lib/toast.js';

export function SttModelManager({ providerId }: { providerId: string }): JSX.Element {
  const [models, setModels]   = useState<AvailableSimpleModelWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await providersApi.listSttModels(providerId);
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
      await providersApi.enableSttModel(providerId, model);
      setModels((ms) => ms.map((m) => (m.id === model ? { ...m, enabled: true } : m)));
    } catch (err) {
      showToast(`启用失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  async function disable(model: string): Promise<void> {
    if (!confirm(`禁用 "${model}"？使用它的 STT 绑定也会一并解除。`)) return;
    try {
      const res = await providersApi.disableSttModel(providerId, model);
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
        <h3 className="text-sm font-medium text-neutral-200">STT 模型</h3>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <span className="i-mdi:refresh text-base" aria-hidden />
        </Button>
      </div>

      {error && <Callout variant="danger">{error}</Callout>}
      {loading && <div className="flex justify-center py-6"><Spinner size="md" /></div>}

      {!loading && (
        <div className="flex flex-col gap-1.5">
          {models.map((m) => (
            <div key={m.id} className="flex items-center justify-between bg-neutral-900/80 backdrop-blur-sm rounded-xl px-3 py-2 border border-neutral-800/40 hover:border-neutral-700/40 active:scale-[0.98] transition-all duration-250">
              <span className="text-sm text-neutral-200 font-mono truncate">{m.id}</span>
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
