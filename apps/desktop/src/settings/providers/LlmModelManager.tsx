/**
 * LlmModelManager — provider 的 LLM 模型池（行存在 = 已启用；保存/删除行走 providersApi）。
 */
import { useState, useEffect, useCallback, type JSX } from 'react';
import { Button, Callout, ConfirmDialog, Divider, Input, Spinner } from '@ema-agent/ui';
import { providersApi, type ProviderModelRecord } from '../../api/providers.js';
import { showToast } from '../../lib/toast.js';
import { ModelToggleCard } from './ModelToggleCard.js';

type LlmModel = Extract<ProviderModelRecord, { capability: 'llm' }>;

export function LlmModelManager({ providerId, iconKey }: { providerId: string; iconKey?: string }): JSX.Element {
  const [models, setModels]   = useState<LlmModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [confirmModel, setConfirmModel] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await providersApi.listModels(providerId);
      setModels(rows.filter((m): m is LlmModel => m.capability === 'llm'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => { void load(); }, [load]);

  async function add(modelId: string, contextWindow: number): Promise<void> {
    try {
      await providersApi.saveModel(providerId, {
        capability: 'llm',
        modelId,
        contextWindow,
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
      await providersApi.deleteModel(providerId, model, 'llm');
      setModels((ms) => ms.filter((m) => m.modelId !== model));
    } catch (err) {
      showToast(`移除失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  const [search, setSearch] = useState('');
  const filtered = search.trim()
    ? models.filter((m) => m.modelId.toLowerCase().includes(search.trim().toLowerCase()))
    : models;

  return (
    <div className="flex flex-col gap-4">
      <Divider />

      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-[var(--ema-text-primary)]">模型</h3>
          <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">
            池内模型才能在「模型绑定」里分配给各模块。
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

      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {filtered.map((m) => (
            <ModelToggleCard
              key={m.modelId}
              id={m.modelId}
              badge={`${m.contextWindow >= 1000000 ? `${(m.contextWindow / 1000000).toFixed(0)}M` : `${(m.contextWindow / 1000).toFixed(0)}K`} ctx`}
              enabled
              onToggle={() => setConfirmModel(m.modelId)}
              logo={iconKey}
            />
          ))}
        </div>
      )}

      <ManualAddModel
        onAdd={(model, ctx) => void add(model, ctx)}
        existing={models.map((m) => m.modelId)}
      />

      <ConfirmDialog
        open={!!confirmModel}
        message={confirmModel ? `从模型池移除 "${confirmModel}"？使用它的模块绑定将失效。` : ''}
        confirmText="移除"
        onConfirm={() => void confirmRemove()}
        onCancel={() => setConfirmModel(null)}
      />
    </div>
  );
}

// ── Manual add ────────────────────────────────────────────────────────────────

function ManualAddModel({ onAdd, existing }: {
  onAdd(model: string, contextWindow: number): void;
  existing: string[];
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [ctx, setCtx]     = useState('');

  function add(): void {
    const model = query.trim();
    const n = parseInt(ctx, 10);
    if (!model) return;
    if (existing.includes(model)) { showToast('该模型已在列表中', { variant: 'warning' }); return; }
    if (!Number.isFinite(n) || n <= 0) { showToast('请填写上下文窗口(正整数 token 数)', { variant: 'danger' }); return; }
    onAdd(model, n);
    setQuery('');
    setCtx('');
  }

  return (
    <div className="mt-1">
      <p className="text-xs text-[var(--ema-text-tertiary)] mb-1.5">添加模型</p>
      <div className="relative flex gap-2">
        <div className="relative flex-1">
          <Input
            inputSize="sm"
            className="font-mono"
            placeholder="模型 ID，如 deepseek-chat"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
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
