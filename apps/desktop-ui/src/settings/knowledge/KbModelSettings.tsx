// 知识库专属嵌入/重排模型选择(settings → kb.models):换嵌入模型会让既有文档过期,
// 标 stale 后可对激活库发起后台重建,进度由 kb_reembed_* SSE 驱动。
import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import { Button, Callout, Select, Spinner } from '@ema-agent/ui';
import { useKbStore } from '../../stores/kb-store.js';
import { showToast } from '../../lib/toast.js';
import { kbApi } from '../../api/knowledge-base.js';
import { settingsApi, type KbModelsConfig, type KbModelRef } from '../../api/settings.js';
import { modelBindingsApi, type AvailableBindingModel } from '../../api/model-bindings.js';
import {
  resolveEmbedSelection,
  sameKbModelRef,
  type ResolvedEmbedSelection,
} from './knowledge-base-embedding-state.js';

const NONE = '__none__';

export function KbModelSettings({ onEmbedModelChanged }: {
  onEmbedModelChanged?: (selection: ResolvedEmbedSelection | undefined) => void;
}): JSX.Element {
  const libs = useKbStore((state) => state.libs);
  const activeLib = libs.find((lib) => lib.isActive);
  const [embedModels,  setEmbedModels]  = useState<AvailableBindingModel[]>([]);
  const [rerankModels, setRerankModels] = useState<AvailableBindingModel[]>([]);
  const [config, setConfig] = useState<KbModelsConfig>({});
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  // 后台重建任务句柄: kb_reembed_* SSE 终态到达后由下方 useEffect 收口。
  const [rebuildTaskId, setRebuildTaskId] = useState<string | null>(null);
  const [rebuildKbId, setRebuildKbId] = useState<string | null>(null);
  const rebuildTask = useKbStore((s) =>
    rebuildTaskId ? Object.values(s.reembedTasks).find((t) => t.taskId === rebuildTaskId) : undefined,
  );

  useEffect(() => {
    if (!rebuildTask) return;
    if (rebuildTask.status === 'done') {
      setRebuilding(false);
      setRebuildTaskId(null);
      setRebuildKbId(null);
      showToast(`重建完成：${rebuildTask.completedItems ?? 0} 个文档`, { variant: 'success' });
    } else if (rebuildTask.status === 'partial_failed') {
      setRebuilding(false);
      setRebuildTaskId(null);
      setRebuildKbId(null);
      showToast(`部分重建失败：${rebuildTask.completedItems ?? 0} 成功，${rebuildTask.failedItems ?? 0} 失败`, { variant: 'warning' });
    } else if (rebuildTask.status === 'cancelled') {
      setRebuilding(false);
      setRebuildTaskId(null);
      setRebuildKbId(null);
      showToast('已取消重建', { variant: 'warning' });
    } else if (rebuildTask.status === 'failed') {
      setRebuilding(false);
      setRebuildTaskId(null);
      setRebuildKbId(null);
      showToast(`重建失败：${rebuildTask.error ?? ''}`, { variant: 'danger' });
    }
  }, [rebuildTask]);

  useEffect(() => {
    void (async () => {
      const [emb, rer, cfg] = await Promise.all([
        modelBindingsApi.listAvailable('embed').catch(() => []),
        modelBindingsApi.listAvailable('rerank').catch(() => []),
        settingsApi.getKbModels().catch(() => ({} as KbModelsConfig)),
      ]);
      setEmbedModels(emb);
      setRerankModels(rer);
      setConfig(cfg);
      onEmbedModelChanged?.(resolveEmbedSelection(emb, cfg.embed));
    })();
  }, [onEmbedModelChanged]);

  const enc = (r?: KbModelRef | null): string => (r ? `${r.providerConfigId}|${r.model}` : NONE);
  const dec = (v: string): KbModelRef | null => {
    if (v === NONE) return null;
    const i = v.indexOf('|');
    return i < 0 ? null : { providerConfigId: v.slice(0, i), model: v.slice(i + 1) };
  };

  async function save(next: KbModelsConfig): Promise<void> {
    if (saving) return;
    const prevEmbed = config.embed;
    setSaving(true);
    try {
      await settingsApi.putKbModels(next);
      setConfig(next);

      // kb.models 是全局配置；切换空间后逐个标记所有注册库，禁止遗漏非 active KB。
      if (!sameKbModelRef(next.embed, prevEmbed)) {
        let markedStale = 0;
        const failedLibraries: string[] = [];
        if (next.embed) {
          for (const lib of libs) {
            try {
              const result = await kbApi.invalidate(
                next.embed.providerConfigId,
                next.embed.model,
                lib.id,
              );
              markedStale += result.markedStale;
            } catch {
              failedLibraries.push(lib.name);
            }
          }
        }
        onEmbedModelChanged?.(resolveEmbedSelection(embedModels, next.embed));
        if (!next.embed) {
          showToast('已保存，知识库将只使用关键词检索', { variant: 'success' });
          return;
        }
        if (failedLibraries.length > 0) {
          showToast(`模型已保存，但以下知识库标记失败：${failedLibraries.join('、')}`, { variant: 'warning' });
          return;
        }
        showToast(`已保存，并标记 ${libs.length} 个知识库中的 ${markedStale} 个文档`, { variant: 'success' });
        return;
      }
      showToast('已保存', { variant: 'success' });
    }
    catch { showToast('保存失败', { variant: 'danger' }); }
    finally { setSaving(false); }
  }

  const opts = (models: AvailableBindingModel[], withNone: boolean) => [
    ...(withNone ? [{ value: NONE, label: '（不使用）' }] : []),
    ...models.map((m) => ({ value: `${m.providerConfigId}|${m.model}`, label: `${m.providerName} / ${m.model}` })),
  ];

  // 提交后台重建任务(202 + taskId); 进度与结果由 kb_reembed_* SSE 驱动,
  // 见上方 useEffect。先 invalidate 标 stale 再入队, 与旧同步流程语义一致。
  async function rebuildIndex(): Promise<void> {
    if (!config.embed) { showToast('请先选择嵌入模型', { variant: 'warning' }); return; }
    if (!activeLib) { showToast('请先激活一个知识库', { variant: 'warning' }); return; }
    setRebuilding(true);
    try {
      await kbApi.invalidate(config.embed.providerConfigId, config.embed.model, activeLib.id);
      const task = await kbApi.reembed({
        ebdProviderId: config.embed.providerConfigId,
        ebdModel: config.embed.model,
        kbId: activeLib.id,
      });
      setRebuildTaskId(task.taskId);
      setRebuildKbId(activeLib.id);
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
            value={enc(config.embed)}
            onChange={(v) => void save({ ...config, embed: dec(v) })}
            options={opts(embedModels, true)}
            placeholder="未设置 → 仅关键词检索"
            disabled={saving || rebuilding}
          />
        </div>
        <div className="flex flex-col gap-1.5 ema-stagger-in" style={{ '--stagger-i': 1 } as CSSProperties}>
          <label className="text-xs text-[var(--ema-text-tertiary)]">重排模型（Rerank，可选）</label>
          <Select
            value={enc(config.rerank)}
            onChange={(v) => void save({ ...config, rerank: dec(v) })}
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
                if (!rebuildTaskId) return;
                if (!rebuildKbId) return;
                void kbApi.cancelReembed(rebuildTaskId, rebuildKbId)
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
            disabled={!config.embed || !activeLib}
            onClick={() => void rebuildIndex()}
          >
            重建{activeLib ? `「${activeLib.name}」` : ''}过期索引
          </Button>
        )}
      </div>
    </section>
  );
}
