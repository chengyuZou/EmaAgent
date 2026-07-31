// 展示角色卡列表、新建入口与删除确认,并在具名对话框中编辑选中的角色卡。
import { useState, type JSX } from 'react';
import { Badge, Button, Callout, Card, ConfirmDialog, Dialog, ScrollArea } from '@ema-agent/ui';
import { useCardStore } from '../../stores/card-store.js';
import type { CharacterCard } from '../../api/cards.js';
import { CharacterCardEditor } from './CharacterCardEditor.js';
import { CreateCardDialog } from './CreateCardDialog.js';
import { showToast } from '../../lib/toast.js';
import type { CharacterCardId } from '@ema-agent/ids';

export function CardsTab(): JSX.Element {
  const cards        = useCardStore((s) => s.cards);
  const activeCardId = useCardStore((s) => s.activeCardId);
  const [selectedId, setSelectedId]   = useState<CharacterCardId | null>(null);
  const [createOpen, setCreateOpen]   = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CharacterCard | null>(null);

  const selected = cards.find((c) => c.id === selectedId);

  async function handleActivate(id: CharacterCardId): Promise<void> {
    try {
      await useCardStore.getState().activate(id);
      showToast('已切换角色', { variant: 'success' });
    } catch (err: unknown) {
      showToast(`切换失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    const card = pendingDelete;
    setPendingDelete(null);
    if (selectedId === card.id) setSelectedId(null);
    try {
      await useCardStore.getState().delete(card.id as CharacterCardId);
      showToast(`已删除 ${card.name}`, { variant: 'success' });
    } catch (err: unknown) {
      showToast(`删除失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 shrink-0">
        <Callout variant="warn" className="flex-1">
          多角色管理为内测新开放能力,可能不稳定:切换或删除前请确认当前对话已保存,遇到问题欢迎反馈。
        </Callout>
        <Button variant="primary" size="sm" icon="i-mdi:plus" onClick={() => setCreateOpen(true)}>
          新建角色
        </Button>
      </div>

      <ScrollArea className="flex-1" viewportClassName="pb-2">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 pr-1">
          {cards.map((card) => (
            <CardListItem
              key={card.id}
              card={card}
              isActive={card.id === activeCardId}
              onSelect={() => setSelectedId(card.id as CharacterCardId)}
              onDelete={card.isBuiltin || card.id === activeCardId
                ? undefined
                : () => setPendingDelete(card)}
            />
          ))}
        </div>
      </ScrollArea>

      <Dialog
        open={!!selected}
        onOpenChange={(o) => { if (!o) setSelectedId(null); }}
        ariaLabel="角色卡编辑器"
        widthClass="max-w-[80vw]"
        className="ema-dialog-decorate"
      >
        {selected && (
          <CharacterCardEditor
            card={selected}
            onActivate={() => handleActivate(selected.id as CharacterCardId)}
          />
        )}
      </Dialog>

      <CreateCardDialog
        key={String(createOpen)}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        message={pendingDelete
          ? `确定删除角色"${pendingDelete.name}"?其 Live2D、立绘与参考音频将一并移入回收区,此操作不可直接撤销。`
          : ''}
        confirmText="删除"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

// ── Card list item (排版抄 AIRI CardListItem: min-h-120 / p-5 / text-lg / text-sm desc) ──

function CardListItem({
  card, isActive, onSelect, onDelete,
}: {
  card:     CharacterCard;
  isActive: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}): JSX.Element {
  return (
    <Card
      variant="elevated"
      className={`cursor-pointer p-5 min-h-[120px] flex flex-col gap-3 transition-all duration-[var(--ema-duration-base)] active:scale-[0.98] ${
        isActive
          ? 'border-2 border-solid border-[var(--ema-primary)] bg-[var(--ema-primary-muted)] ema-card-decorate ema-card-decorate--mesh'
          : 'border-2 border-solid border-[var(--ema-border)] hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)] ema-card-decorate ema-card-decorate--mesh'
      }`}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-lg font-semibold text-[var(--ema-text-primary)] leading-snug truncate">{card.name}</span>
        <div className="flex items-center gap-1 shrink-0">
          {isActive && <Badge variant="success" dot>当前</Badge>}
          {card.isBuiltin && <Badge variant="neutral">内置</Badge>}
          {onDelete && (
            <Button
              variant="ghost"
              size="sm"
              className="text-[var(--ema-text-tertiary)] hover:text-[var(--ema-danger)] px-1.5"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
            >
              <span className="i-mdi:delete-outline text-base" aria-hidden />
            </Button>
          )}
        </div>
      </div>
      {card.description && (
        <p className="text-sm text-[var(--ema-text-tertiary)] line-clamp-3 min-h-[40px] flex-1">{card.description}</p>
      )}
      <div className="flex items-center justify-between text-xs text-[var(--ema-text-tertiary)]">
        <span>v{card.version}</span>
      </div>
    </Card>
  );
}
