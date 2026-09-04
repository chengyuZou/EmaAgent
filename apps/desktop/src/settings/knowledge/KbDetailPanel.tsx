// 库详情页骨架:头部(名称/路径/打开目录 + Embedding/Rerank 库级模型配置)与三个 Tab。
// 详情页按"正在查看的库"工作——激活与否不影响本页任何操作(激活只决定 Agent 检索目标)。
import { useEffect, useState, type JSX } from 'react';
import { Button, Callout, Input, Select, Tabs } from '@ema-agent/ui';
import { knowledgeApi, type KnowledgeLibrary } from '../../api/knowledge.js';
import { providersApi, type AvailableModel } from '../../api/providers.js';
import { ServerApiError } from '../../api/client.js';
import { useKnowledgeStore } from '../../stores/knowledge.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { showToast } from '../../lib/toast.js';
import { KbDocumentsTab } from './KbDocumentsTab.js';
import { KbTasksTab } from './KbTasksTab.js';
import { KbSearchTab } from './KbSearchTab.js';

/** Select 值 = 模型引用的 JSON;providerId/modelId 都可能含斜杠,序列化最稳。
 *  Radix Select 禁止空字符串 value(保留给"清除选择"),"不启用"用非空哨兵。 */
const NO_RERANK = '__none__';
function encodeRef(ref: { providerId: string; modelId: string } | null): string {
  return ref ? JSON.stringify(ref) : NO_RERANK;
}
function decodeRef(value: string): { providerId: string; modelId: string } | null {
  return value === NO_RERANK ? null : JSON.parse(value) as { providerId: string; modelId: string };
}

export function KbDetailPanel({ lib, onBack }: {
  lib: KnowledgeLibrary;
  onBack(): void;
}): JSX.Element {
  const [tab, setTab] = useState('documents');
  const [embedModels, setEmbedModels] = useState<AvailableModel[]>([]);
  const [rerankModels, setRerankModels] = useState<AvailableModel[]>([]);
  const [savingModels, setSavingModels] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([providersApi.listAvailable('embed'), providersApi.listAvailable('rerank')])
      .then(([embed, rerank]) => {
        if (cancelled) return;
        setEmbedModels(embed.models);
        setRerankModels(rerank.models);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  /** Embedding 变更:该库既有索引标 stale,文档列表与库卡计数刷新。 */
  async function saveEmbed(ref: { providerId: string; modelId: string } | null): Promise<void> {
    if (savingModels) return;
    setSavingModels(true);
    try {
      await knowledgeApi.patchLibModels(lib.id, { embed: ref });
      await useKnowledgeStore.getState().loadLibs();
      await useKnowledgeStore.getState().loadDocuments();
      showToast('已更新 Embedding；既有索引已标记待重建', { variant: 'warning' });
    } catch (err) {
      const message = err instanceof ServerApiError && err.message ? err.message : '保存失败';
      showToast(message, { variant: 'danger' });
    } finally {
      setSavingModels(false);
    }
  }

  async function saveRerank(ref: { providerId: string; modelId: string } | null): Promise<void> {
    if (savingModels) return;
    setSavingModels(true);
    try {
      await knowledgeApi.patchLibModels(lib.id, { rerank: ref });
      await useKnowledgeStore.getState().loadLibs();
      showToast('已更新', { variant: 'success' });
    } catch (err) {
      const message = err instanceof ServerApiError && err.message ? err.message : '保存失败';
      showToast(message, { variant: 'danger' });
    } finally {
      setSavingModels(false);
    }
  }

  const embedOptions = embedModels.map((model) => ({
    value: JSON.stringify({ providerId: model.providerId, modelId: model.modelId }),
    label: `${model.providerId} / ${model.modelId}`,
  }));
  const rerankOptions = [
    { value: NO_RERANK, label: '不启用' },
    ...rerankModels.map((model) => ({
      value: JSON.stringify({ providerId: model.providerId, modelId: model.modelId }),
      label: `${model.providerId} / ${model.modelId}`,
    })),
  ];

  const [renaming, setRenaming] = useState(false);
  const [nameInput, setNameInput] = useState(lib.name);

  async function commitRename(): Promise<void> {
    const trimmed = nameInput.trim();
    setRenaming(false);
    if (!trimmed || trimmed === lib.name) { setNameInput(lib.name); return; }
    try {
      await useKnowledgeStore.getState().renameLib(lib.id, trimmed);
      showToast('已重命名', { variant: 'success' });
    } catch {
      setNameInput(lib.name);
    }
  }

  return (
    <div className="flex flex-col gap-4 ema-slide-right">
      {/* 头部:名称(可改)/路径 + 右上操作区 [打开目录][返回] */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`size-2.5 rounded-full shrink-0 ${lib.isActive ? 'bg-[var(--ema-success)]' : 'border-2 border-solid border-[var(--ema-border-strong)]'}`}
                title={lib.isActive ? 'Agent 检索目标库' : undefined} aria-hidden />
          {renaming ? (
            <Input
              className="text-sm h-8 max-w-64"
              value={nameInput}
              autoFocus
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename();
                if (e.key === 'Escape') { setRenaming(false); setNameInput(lib.name); }
              }}
            />
          ) : (
            <h2 className="text-base font-semibold text-[var(--ema-text-primary)] truncate">{lib.name}</h2>
          )}
          {!renaming && (
            <Button variant="ghost" size="sm" className="shrink-0 px-1.5" onClick={() => { setRenaming(true); setNameInput(lib.name); }}>
              <span className="i-solar:pen-bold text-sm" aria-hidden />
            </Button>
          )}
          <span className="text-xs font-mono text-[var(--ema-text-tertiary)] truncate">{lib.path}</span>
          <div className="flex items-center gap-2 shrink-0 ml-auto">
            <Button
              variant="ghost" size="sm"
              onClick={() => void tauriBridge.openPath(lib.path)
                .catch((err) => showToast(`打开目录失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' }))}
            >
              打开目录
            </Button>
            <Button variant="ghost" size="sm" onClick={onBack}>
              <span className="i-lucide:arrow-left mr-1" aria-hidden />返回
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-3xl">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--ema-text-tertiary)]">Embedding（索引由它建立）</span>
            <Select
              value={lib.embed ? encodeRef(lib.embed) : undefined}
              onChange={(v) => void saveEmbed(decodeRef(v))}
              options={embedOptions}
              placeholder={embedModels.length === 0 ? '无可用嵌入模型' : '选择嵌入模型…'}
              disabled={savingModels || embedModels.length === 0}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--ema-text-tertiary)]">Rerank（可选）</span>
            <Select
              value={encodeRef(lib.rerank)}
              onChange={(v) => void saveRerank(decodeRef(v))}
              options={rerankOptions}
              disabled={savingModels}
            />
          </div>
        </div>

        <p className="text-[11px] text-[var(--ema-text-tertiary)]">
          更换 Embedding 后，该库既有索引会标记为待重建；未配置 Embedding 时不能导入或检索。
        </p>
        {!lib.embed && (
          <Callout variant="warn" className="text-xs">当前库未配置 Embedding 模型——导入与检索不可用，请先在上面选择。</Callout>
        )}
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        variant="underline"
        items={[
          { value: 'documents', label: `文档${lib.documentCount > 0 ? ` · ${lib.documentCount}` : ''}`, content: <KbDocumentsTab lib={lib} /> },
          { value: 'tasks', label: '任务', content: <KbTasksTab lib={lib} /> },
          { value: 'search', label: '检索', content: <KbSearchTab lib={lib} /> },
        ]}
      />
    </div>
  );
}
