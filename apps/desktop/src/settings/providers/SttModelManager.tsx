/**
 * SttModelManager — provider 的 STT 模型池。
 */
import { useState, useEffect, useCallback, type JSX } from 'react';
import { Button, Callout, ConfirmDialog, Input, Spinner } from '@ema-agent/ui';
import { providersApi, type ProviderModelRecord } from '../../api/providers.js';
import { showToast } from '../../lib/toast.js';
import { ModelToggleCard } from './ModelToggleCard.js';

type SttModel = Extract<ProviderModelRecord, { capability: 'stt' }>;

export function SttModelManager({ providerId, iconKey }: { providerId: string; iconKey?: string }): JSX.Element {
  const [models, setModels]   = useState<SttModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [confirmModel, setConfirmModel] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await providersApi.listModels(providerId);
      setModels(rows.filter((m): m is SttModel => m.capability === 'stt'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => { void load(); }, [load]);

  async function add(modelId: string): Promise<void> {
    try {
      await providersApi.saveModel(providerId, {
        capability: 'stt',
        modelId,
      });
      await load();
    } catch (err) {
      showToast(`添加失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  async function confirmRemove(): Promise<void> {
    if (!confirmModel) return;
    const model = confirmModel;
    setConfirmModel(null);
    try {
      await providersApi.deleteModel(providerId, model, 'stt');
      setModels((ms) => ms.filter((m) => m.modelId !== model));
    } catch (err) {
      showToast(`移除失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-3 mt-2">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-[var(--ema-text-primary)]">STT 模型</h3>
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
              key={m.modelId}
              id={m.modelId}
              enabled
              onToggle={() => setConfirmModel(m.modelId)}
              logo={iconKey}
            />
          ))}
        </div>
      )}

      <ManualAddSttModel
        onAdd={(model) => void add(model)}
        existing={models.map((m) => m.modelId)}
      />

      <ConfirmDialog
        open={!!confirmModel}
        message={confirmModel ? `从模型池移除 "${confirmModel}"？使用它的 STT 绑定将失效。` : ''}
        confirmText="移除"
        onConfirm={() => void confirmRemove()}
        onCancel={() => setConfirmModel(null)}
      />
    </div>
  );
}

function ManualAddSttModel({ onAdd, existing }: {
  onAdd(model: string): void;
  existing: string[];
}): JSX.Element {
  const [query, setQuery] = useState('');

  function add(): void {
    const model = query.trim();
    if (!model) return;
    if (existing.includes(model)) { showToast('该模型已在列表中', { variant: 'warning' }); return; }
    onAdd(model);
    setQuery('');
  }

  return (
    <div className="mt-1">
      <p className="text-xs text-[var(--ema-text-tertiary)] mb-1.5">添加 STT 模型</p>
      <div className="relative flex gap-2">
        <div className="relative flex-1">
          <Input
            inputSize="sm"
            className="font-mono"
            placeholder="模型 ID，如 whisper-large-v3"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button variant="secondary" size="sm" onClick={add}>添加</Button>
      </div>
    </div>
  );
}
