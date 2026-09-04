// 知识库主装配:L1 库卡网格(点卡身=打开该库详情;激活是独立按钮) 与 L2 库详情(文档/任务/检索)。
// 激活只决定 Agent 检索目标库;任何库都能查看与跑任务。确认流程归本页;数据归 stores/knowledge。
import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import { Callout, ConfirmDialog, EmptyState, Spinner } from '@ema-agent/ui';
import { useKnowledgeStore } from '../../stores/knowledge.js';
import type { KnowledgeLibrary } from '../../api/knowledge.js';
import { showToast } from '../../lib/toast.js';
import { AddDashedCard } from '../providers/AddDashedCard.js';
import { KbLibraryCard } from './KbLibraryCard.js';
import { KbCreateDialog } from './KbCreateDialog.js';
import { KbDetailPanel } from './KbDetailPanel.js';

export function KnowledgeBaseTab(): JSX.Element {
  const libs     = useKnowledgeStore((s) => s.libs);
  const loading  = useKnowledgeStore((s) => s.libsLoading);
  const error    = useKnowledgeStore((s) => s.libsError);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<KnowledgeLibrary | null>(null);

  useEffect(() => { void useKnowledgeStore.getState().loadLibs(); }, []);

  const selected = libs.find((lib) => lib.id === selectedId) ?? null;

  /** 打开任意库的详情(查看目标,与激活无关)。 */
  function openLibrary(lib: KnowledgeLibrary): void {
    useKnowledgeStore.getState().setViewingKb(lib.id);
    setSelectedId(lib.id);
  }

  function back(): void {
    useKnowledgeStore.getState().setViewingKb(null);
    setSelectedId(null);
  }

  async function confirmDelete(): Promise<void> {
    if (!deleting) return;
    const lib = deleting;
    setDeleting(null);
    if (lib.isActive) {
      showToast('激活中的知识库不能删除,先激活别的库', { variant: 'warning' });
      return;
    }
    try {
      await useKnowledgeStore.getState().deleteLib(lib.id);
      if (selectedId === lib.id) back();
      showToast(`已永久删除「${lib.name}」`, { variant: 'success' });
    } catch (err) {
      showToast(`删除失败: ${err instanceof Error ? err.message : '未知错误'}`, { variant: 'danger' });
    }
  }

  if (selected) {
    return <KbDetailPanel lib={selected} onBack={back} />;
  }

  return (
    <div className="flex flex-col gap-4 ema-fade-in">
      <div className="shrink-0">
        <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">知识库</h2>
        <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 leading-relaxed">
          管理你的文档知识库,供 Agent 检索引用。点开库卡即可查看与管理;
          「激活」只决定 Agent 检索哪个库——任何库的任务都照常运行。
        </p>
      </div>

      {error && <Callout variant="danger" className="text-xs ema-fade-in">{error}</Callout>}

      {loading && libs.length === 0 ? (
        <div className="flex justify-center py-10"><Spinner size="md" /></div>
      ) : libs.length === 0 ? (
        <EmptyState icon="i-solar:database-bold" title="暂无知识库" hint="点击下方新建,选个父文件夹就好" animate className="py-16" />
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {libs.map((lib, i) => (
          <div key={lib.id} className="ema-stagger-in" style={{ '--stagger-i': i } as CSSProperties}>
            <KbLibraryCard
              lib={lib}
              onOpen={() => openLibrary(lib)}
              onActivate={() => void useKnowledgeStore.getState().activateLib(lib.id)
                .then(() => showToast(`Agent 检索目标已切换到「${lib.name}」`, { variant: 'success' }))}
              onDelete={() => setDeleting(lib)}
            />
          </div>
        ))}
        <div className="ema-stagger-in" style={{ '--stagger-i': libs.length } as CSSProperties}>
          <AddDashedCard label="新建知识库" onClick={() => setCreating(true)} />
        </div>
      </div>

      <KbCreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => {
          void useKnowledgeStore.getState().loadLibs().then(() => {
            const created = useKnowledgeStore.getState().libs.find((lib) => lib.id === id);
            if (created) openLibrary(created);
          });
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        message={deleting
          ? `删除「${deleting.name}」将永久移除整个知识库及其全部文件,不可恢复。`
          : ''}
        confirmText="永久删除"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
