// 知识库专属嵌入/重排模型绑定(providers bindings 的 kb-embed / kb-rerank):
// 换嵌入绑定后服务端自动把全部 KB 标记过期,可对激活库发起后台重建,进度由 kb_reembed_* SSE 驱动。
import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import { Button, Callout, Select, Spinner } from '@ema-agent/ui';
import { useKnowledgeStore } from '../../stores/knowledge-store.js';
import { showToast } from '../../lib/toast.js';
import { knowledgeApi } from '../../api/knowledge.js';
import {
  providersApi,
  type AvailableModel,
  type BindingModule,
  type BindingRecord,
} from '../../api/providers.js';
import {
  resolveEmbedSelection,
  sameEmbedSelection,
  type ResolvedEmbedSelection,
} from './knowledge-base-embedding-state.js';

const NONE = '__none__';

interface ModelRef {
  providerId: string;
  modelId: string;
}

export function KbModelSettings({ onEmbedModelChanged }: {
  onEmbedModelChanged?: (selection: ResolvedEmbedSelection | undefined) => void;
}): JSX.Element {
  const libs = useKnowledgeStore((state) => state.libs);
  const activeLib = libs.find((lib) => lib.isActive);
  const [embedModels,  setEmbedModels]  = useState<AvailableModel[]>([]);
  const [rerankModels, setRerankModels] = useState<AvailableModel[]>([]);
  const [embedRef,  setEmbedRef]  = useState<ModelRef | null>(null);
  const [rerankRef, setRerankRef] = useState<ModelRef | null>(null);
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  // 后台重建进度:kb_reembed_* SSE 落到 store.reembedTasks(按 kbId),终态到达后下方 useEffect 收口。
  const rebuildTask = useKnowledgeStore((s) =>
    activeLib ? s.reembedTasks[activeLib.id] : undefined,
  );

  useEffect(() => {
    if (!rebuilding || !rebuildTask) return;
    if (rebuildTask.status === 'completed') {
      setRebuilding(false);
      showToast(`重建完成：${rebuildTask.completedItems ?? 0} 个文档`, { variant: 'success' });
    } else if (rebuildTask.status === 'cancelled') {
      setRebuilding(false);
      showToast('已取消重建', { variant: 'warning' });
    } else if (rebuildTask.status === 'failed') {
      setRebuilding(false);
      showToast(`重建失败：${rebuildTask.error ?? ''}`, { variant: 'danger' });
    }
  }, [rebuilding, rebuildTask]);

  useEffect(() => {
    void (async () => {
      const [emb, rer, bindings] = await Promise.all([
        providersApi.listAvailable('embed').catch(() => null),
        providersApi.listAvailable('rerank').catch(() => null),
        providersApi.listBindings().catch(() => []),
      ]);
      const embedItems = emb?.models ?? [];
      const rerankItems = rer?.models ?? [];
      setEmbedModels(embedItems);
      setRerankModels(rerankItems);
      const embedBinding = bindings.find((b) => b.module === 'kb-embed');
      const rerankBinding = bindings.find((b) => b.module === 'kb-rerank');
      const embed = embedBinding ? { providerId: embedBinding.providerId, modelId: embedBinding.modelId } : null;
      const rerank = rerankBinding ? { providerId: rerankBinding.providerId, modelId: rerankBinding.modelId } : null;
      setEmbedRef(embed);
      setRerankRef(rerank);
      onEmbedModelChanged?.(resolveEmbedSelection(embedItems, embed));
    })();
  }, [onEmbedModelChanged]);

  const enc = (r?: ModelRef | null): string => (r ? `${r.providerId}|${r.modelId}` : NONE);
  const dec = (v: string): ModelRef | null => {
    if (v === NONE) return null;
    const i = v.indexOf('|');
    return i < 0 ? null : { providerId: v.slice(0, i), modelId: v.slice(i + 1) };
  };

  async function save(module: BindingModule, next: ModelRef | null): Promise<void> {
    if (saving) return;
    const prevEmbed = embedRef;
    setSaving(true);
    try {
      let binding: BindingRecord | null = null;
      if (next) {
        binding = await providersApi.setBinding(module, { providerId: next.providerId, modelId: next.modelId });
      } else {
        await providersApi.deleteBinding(module);
      }
      if (module === 'kb-embed') {
        setEmbedRef(binding ? { providerId: binding.providerId, modelId: binding.modelId } : null);
        const selection = resolveEmbedSelection(embedModels, binding);
        onEmbedModelChanged?.(selection);
        // kb-embed 绑定变更由服务端自动标 stale 全部 KB,前端只提示后续动作。
        if (!next) {
          showToast('已保存，知识库将只使用关键词检索', { variant: 'success' });
        } else if (!sameEmbedSelection(
          resolveEmbedSelection(embedModels, prevEmbed),
          selection,
        )) {
          showToast('已保存，既有文档已标记过期，请重建索引', { variant: 'warning' });
        } else {
          showToast('已保存', { variant: 'success' });
        }
      } else {
        setRerankRef(binding ? { providerId: binding.providerId, modelId: binding.modelId } : null);
        showToast('已保存', { variant: 'success' });
      }
    }
    catch { showToast('保存失败', { variant: 'danger' }); }
    finally { setSaving(false); }
  }

  const opts = (models: AvailableModel[], withNone: boolean) => [
    ...(withNone ? [{ value: NONE, label: '（不使用）' }] : []),
    ...models.map((m) => ({ value: `${m.providerId}|${m.modelId}`, label: `${m.providerName} / ${m.modelId}` })),
  ];

  // 整库重建 = 先取 stale 清单再整单入队(202);进度与结果由 kb_reembed_* SSE 驱动,见上方 useEffect。
  async function rebuildIndex(): Promise<void> {
    if (!embedRef) { showToast('请先选择嵌入模型', { variant: 'warning' }); return; }
    if (!activeLib) { showToast('请先激活一个知识库', { variant: 'warning' }); return; }
    setRebuilding(true);
    try {
      const stale = await knowledgeApi.listStaleAssets(activeLib.id);
      if (stale.items.length === 0) {
        setRebuilding(false);
        showToast('没有需要重建的文档', { variant: 'success' });
        return;
      }
      await knowledgeApi.reembed({ assetIds: [...stale.items], kbId: activeLib.id });
    } catch {
      setRebuilding(false);
      showToast('重建任务提交失败', { variant: 'danger' });
    }
  }

  return (
    <section className="flex flex-col gap-3 ema-fade-in">
      <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">检索模型</h2>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5 ema-stagger-in" style={{ '--stagger-i': 0 } as CSSProperties}>
          <label className="text-xs text-[var(--ema-text-tertiary)]">嵌入模型（Embedding）</label>
          <Select
            value={enc(embedRef)}
            onChange={(v) => void save('kb-embed', dec(v))}
            options={opts(embedModels, true)}
            placeholder="未设置 → 仅关键词检索"
            disabled={saving || rebuilding}
          />
        </div>
        <div className="flex flex-col gap-1.5 ema-stagger-in" style={{ '--stagger-i': 1 } as CSSProperties}>
          <label className="text-xs text-[var(--ema-text-tertiary)]">重排模型（Rerank，可选）</label>
          <Select
            value={enc(rerankRef)}
            onChange={(v) => void save('kb-rerank', dec(v))}
            options={opts(rerankModels, true)}
            placeholder="（不使用）"
            disabled={saving || rebuilding}
          />
        </div>
      </div>

      <Callout variant="warn" className="text-xs leading-relaxed ema-slide-up">
        换<b>嵌入模型</b>会让已索引文档的向量与新查询<b>错配、检索骤减</b>——换完点下方<b>重建过期索引</b>。
        重排模型可随时更换，无需重建。此处与「叙事模式」的 LightRAG 嵌入互不影响。
      </Callout>

      {libs.length > 0 && (
        <p className="text-[11px] text-[var(--ema-text-tertiary)]">
          影响范围：{libs.slice(0, 4).map((lib) => lib.name).join('、')}
          {libs.length > 4 ? ` 等 ${libs.length} 个知识库` : `（${libs.length} 个知识库）`}
        </p>
      )}

      <div className="flex items-center justify-between gap-2 ema-fade-in">
        <p className="text-[11px] text-[var(--ema-text-tertiary)]">
          把所有「未嵌入 / 过期」的文档用当前嵌入模型重新建立向量索引。
        </p>
        {rebuilding ? (
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="secondary" size="sm" disabled>
              <Spinner size="sm" className="mr-1.5" />重建中…
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (!activeLib) return;
                const taskId = rebuildTask?.taskId;
                if (!taskId) return;
                void knowledgeApi.cancelReembed(taskId, activeLib.id)
                  .catch(() => showToast('取消失败', { variant: 'danger' }));
              }}
            >
              取消
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            disabled={!embedRef || !activeLib}
            onClick={() => void rebuildIndex()}
          >
            重建{activeLib ? `「${activeLib.name}」` : ''}过期索引
          </Button>
        )}
      </div>
    </section>
  );
}
