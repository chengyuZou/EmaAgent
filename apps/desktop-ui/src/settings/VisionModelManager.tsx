import { useState, useEffect, useCallback, type JSX } from 'react';
import { Button, Callout, ConfirmDialog, Spinner } from '@ema-agent/ui';
import { providersApi, type AvailableSimpleModelWire } from '../api/providers.js';
import { showToast } from '../lib/toast.js';
import { ModelToggleCard } from './ModelToggleCard.js';

export function VisionModelManager({ providerId, iconKey }: { providerId: string; iconKey?: string }): JSX.Element {
  const [models, setModels]   = useState<AvailableSimpleModelWire[]>([]);
  const [source, setSource]   = useState<'static' | 'catalog'>('static');
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [confirmModel, setConfirmModel] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await providersApi.listVisionModels(providerId);
      setModels(res.models);
      setSource(res.source);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => { void load(); }, [load]);

  async function enable(model: string): Promise<void> {
    try {
      await providersApi.enableVisionModel(providerId, model);
      setModels((ms) => ms.map((m) => (m.id === model ? { ...m, enabled: true } : m)));
    } catch (err) {
      showToast(`启用失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  async function confirmDisable(): Promise<void> {
    if (!confirmModel) return;
    const model = confirmModel;
    setConfirmModel(null);
    try {
      const res = await providersApi.disableVisionModel(providerId, model);
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
          <h3 className="text-base font-semibold text-[var(--ema-text-primary)]">Vision 模型</h3>
          <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">
            启用的模型可在「模型绑定」里分配给 vision 模块。
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
              enabled={m.enabled}
              onToggle={() => void (m.enabled ? setConfirmModel(m.id) : enable(m.id))}
              logo={iconKey}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmModel}
        message={confirmModel ? `禁用 "${confirmModel}"？使用它的 Vision 绑定也会一并解除。` : ''}
        confirmText="禁用"
        onConfirm={() => void confirmDisable()}
        onCancel={() => setConfirmModel(null)}
      />
    </div>
  );
}
