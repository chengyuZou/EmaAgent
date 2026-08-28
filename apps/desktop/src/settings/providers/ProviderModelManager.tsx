// Provider 模型池管理：行存在 = 已启用；保存/删除行走 providersApi。
// 六种能力共用一条主链，按 capability 穷尽渲染差异（徽章、添加表单数字字段、TTS 试听）。
import { useState, useEffect, useCallback, type JSX } from 'react';
import { Button, Callout, ConfirmDialog, IconButton, Input, Spinner } from '@ema-agent/ui';
import {
  providersApi,
  type ModelCapability,
  type ProviderModelInput,
  type ProviderModelRecord,
} from '../../api/providers.js';
import { showToast } from '../../lib/toast.js';
import { ModelToggleCard } from './ModelToggleCard.js';

const DEFAULT_TEST_TEXT = '你好，我是艾玛，很高兴认识你。';

// 各能力的页面文案与"添加模型"数字字段；Record 穷尽检查，capability 联合新增成员时编译报错。
const CAPABILITY_META: Record<ModelCapability, {
  title: string;
  hint?: string;
  addLabel: string;
  idPlaceholder: string;
  numericField?: { placeholder: string; invalid: string };
}> = {
  llm: {
    title: '模型',
    hint: '池内模型才能在「模型绑定」里分配给各模块。',
    addLabel: '添加模型',
    idPlaceholder: '模型 ID，如 deepseek-chat',
    numericField: { placeholder: '窗口 token', invalid: '请填写上下文窗口(正整数 token 数)' },
  },
  embed: {
    title: '嵌入模型',
    hint: '池内模型可在「模型绑定」里分配给 embed 模块。',
    addLabel: '添加嵌入模型',
    idPlaceholder: '模型 ID，如 bge-m3',
    numericField: { placeholder: '维度', invalid: '维度需为正整数' },
  },
  rerank: {
    title: '重排序模型',
    hint: '池内模型可在「模型绑定」里分配给 rerank 模块。',
    addLabel: '添加重排序模型',
    idPlaceholder: '模型 ID，如 bge-reranker-v2-m3',
  },
  vision: {
    title: 'Vision 模型',
    hint: '池内模型可在「模型绑定」里分配给 vision 模块。',
    addLabel: '添加 Vision 模型',
    idPlaceholder: '模型 ID，如 glm-4v',
    numericField: { placeholder: '窗口 token', invalid: '请填写上下文窗口(正整数 token 数)' },
  },
  tts: {
    title: 'TTS 模型',
    addLabel: '添加 TTS 模型',
    idPlaceholder: '模型 ID，如 cosyvoice-v1',
  },
  stt: {
    title: 'STT 模型',
    addLabel: '添加 STT 模型',
    idPlaceholder: '模型 ID，如 whisper-large-v3',
  },
};

/** 卡片徽标按模型自带判别值分派；无附加参数的 capability 不给徽标。 */
function badgeOf(model: ProviderModelRecord): string | undefined {
  switch (model.capability) {
    case 'llm':
    case 'vision':
      return `${formatContextWindow(model.contextWindow)} ctx`;
    case 'embed':
      return `${model.dim}d`;
    case 'rerank':
      return model.maxChunks != null ? `max ${model.maxChunks}` : undefined;
    default:
      return undefined;
  }
}

function formatContextWindow(tokens: number): string {
  return tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(0)}M`
    : `${(tokens / 1_000).toFixed(0)}K`;
}

/** 添加表单提交 → Route 输入联合；需要数字参数的 capability 缺数时返回 null（表单已拦截）。 */
function buildModelInput(
  capability: ModelCapability,
  modelId: string,
  numeric: number | undefined,
): ProviderModelInput | null {
  switch (capability) {
    case 'llm':
    case 'vision':
      return numeric === undefined ? null : { capability, modelId, contextWindow: numeric };
    case 'embed':
      return numeric === undefined ? null : { capability, modelId, dim: numeric };
    case 'rerank':
      return { capability, modelId };
    case 'tts':
      return { capability, modelId };
    case 'stt':
      return { capability, modelId };
  }
}

export function ProviderModelManager({ providerId, capability, iconKey }: {
  providerId: string;
  capability: ModelCapability;
  iconKey?: string;
}): JSX.Element {
  const meta = CAPABILITY_META[capability];
  const [models, setModels]   = useState<ProviderModelRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [confirmModel, setConfirmModel] = useState<string | null>(null);
  const [search, setSearch]   = useState('');
  const [testText, setTestText] = useState(DEFAULT_TEST_TEXT);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await providersApi.listModels(providerId);
      setModels(rows.filter((m) => m.capability === capability));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [providerId, capability]);

  useEffect(() => { void load(); }, [load]);

  async function add(modelId: string, numeric: number | undefined): Promise<void> {
    const input = buildModelInput(capability, modelId, numeric);
    if (!input) return;
    try {
      await providersApi.saveModel(providerId, input);
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
      await providersApi.deleteModel(providerId, model, capability);
      setModels((ms) => ms.filter((m) => m.modelId !== model));
    } catch (err) {
      showToast(`移除失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  /** TTS 试听：音频字节流经 ttsPreview 取回本地播放。 */
  async function handleTest(modelId: string): Promise<void> {
    setTesting(modelId);
    try {
      const res = await providersApi.ttsPreview(providerId, modelId, testText);
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
      await audio.play();
      showToast('正在播放测试声音', { variant: 'success' });
    } catch (err) {
      showToast(`测试失败: ${err instanceof Error ? err.message : '未知错误'}`, { variant: 'danger' });
    } finally {
      setTesting(null);
    }
  }

  const filtered = search.trim()
    ? models.filter((m) => m.modelId.toLowerCase().includes(search.trim().toLowerCase()))
    : models;

  return (
    <div className="flex flex-col gap-3 mt-2">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-[var(--ema-text-primary)]">{meta.title}</h3>
          {meta.hint && (
            <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">{meta.hint}</p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <span className="i-mdi:refresh text-base" aria-hidden />
        </Button>
      </div>

      {capability === 'llm' && (
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
      )}

      {error && <Callout variant="danger">{error}</Callout>}
      {loading && <div className="flex justify-center py-6"><Spinner size="md" /></div>}

      {!loading && (
        <>
          {capability === 'rerank' && models.length === 0 && (
            <p className="text-xs text-[var(--ema-text-tertiary)] py-2">该供应商暂无重排序模型。</p>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {filtered.map((m) => (
              <ModelToggleCard
                key={m.modelId}
                id={m.modelId}
                badge={badgeOf(m)}
                enabled
                onToggle={() => setConfirmModel(m.modelId)}
                logo={iconKey}
                {...(capability === 'tts'
                  ? {
                    action: (
                      <IconButton
                        label="测试声音"
                        iconNode={
                          <span
                            className={testing === m.modelId
                              ? 'i-mdi:volume-high animate-pulse text-[var(--ema-primary)]'
                              : 'i-mdi:volume-high'}
                            aria-hidden
                          />
                        }
                        disabled={testing !== null}
                        variant="default"
                        size="sm"
                        type="button"
                        onClick={() => void handleTest(m.modelId)}
                      />
                    ),
                  }
                  : {})}
              />
            ))}
          </div>
        </>
      )}

      <ManualAddModel
        meta={meta}
        onAdd={(model, numeric) => void add(model, numeric)}
        existing={models.map((m) => m.modelId)}
      />

      {capability === 'tts' && (
        <div className="flex gap-2 mt-1">
          <Input
            placeholder="测试文本"
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
          />
        </div>
      )}

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

// ── 手动添加 ──────────────────────────────────────────────────────────────────

function ManualAddModel({ meta, onAdd, existing }: {
  meta: typeof CAPABILITY_META[ModelCapability];
  onAdd(model: string, numeric: number | undefined): void;
  existing: string[];
}): JSX.Element {
  const [query, setQuery]     = useState('');
  const [numeric, setNumeric] = useState('');

  function add(): void {
    const model = query.trim();
    if (!model) return;
    if (existing.includes(model)) { showToast('该模型已在列表中', { variant: 'warning' }); return; }
    let parsed: number | undefined;
    if (meta.numericField) {
      const n = parseInt(numeric, 10);
      if (!Number.isFinite(n) || n <= 0) {
        showToast(meta.numericField.invalid, { variant: 'danger' });
        return;
      }
      parsed = n;
    }
    onAdd(model, parsed);
    setQuery('');
    setNumeric('');
  }

  return (
    <div className="mt-1">
      <p className="text-xs text-[var(--ema-text-tertiary)] mb-1.5">{meta.addLabel}</p>
      <div className="relative flex gap-2">
        <div className="relative flex-1">
          <Input
            inputSize="sm"
            className="font-mono"
            placeholder={meta.idPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {meta.numericField && (
          <Input
            type="number"
            inputSize="sm"
            className="w-28 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            placeholder={meta.numericField.placeholder}
            value={numeric}
            onChange={(e) => setNumeric(e.target.value)}
          />
        )}
        <Button variant="secondary" size="sm" onClick={add}>添加</Button>
      </div>
    </div>
  );
}
