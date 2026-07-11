import { useState, type JSX } from 'react';
import { Badge, Card, Dialog, ScrollArea } from '@ema-agent/ui';
import { useCardStore } from '../stores/card-store.js';
import type { CharacterCard } from '../api/cards.js';
import { CharacterCardEditor } from './CharacterCardEditor.js';
import { showToast } from '../lib/toast.js';
import type { CharacterCardId } from '@ema-agent/contracts';

export function CardsTab(): JSX.Element {
  const cards        = useCardStore((s) => s.cards);
  const activeCardId = useCardStore((s) => s.activeCardId);
  const [selectedId, setSelectedId] = useState<CharacterCardId | null>(null);

  const selected = cards.find((c) => c.id === selectedId);

  async function handleActivate(id: CharacterCardId): Promise<void> {
    try {
      await useCardStore.getState().activate(id);
      showToast('已切换角色', { variant: 'success' });
    } catch (err: unknown) {
      showToast(`切换失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* TODO: V1 单角色，暂不开放新建入口，待多角色支持后恢复。 */}
      <ScrollArea className="flex-1" viewportClassName="pb-2">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 pr-1">
          {cards.map((card) => (
            <CardListItem
              key={card.id}
              card={card}
              isActive={card.id === activeCardId}
              onSelect={() => setSelectedId(card.id as CharacterCardId)}
            />
          ))}
        </div>
      </ScrollArea>

      <Dialog
        open={!!selected}
        onOpenChange={(o) => { if (!o) setSelectedId(null); }}
        widthClass="max-w-4xl"
        className="ema-dialog-decorate"
      >
        {selected && (
          <CharacterCardEditor
            card={selected}
            onActivate={() => handleActivate(selected.id as CharacterCardId)}
          />
        )}
      </Dialog>
    </div>
  );
}

// ── Card list item (排版抄 AIRI CardListItem: min-h-120 / p-5 / text-lg / text-sm desc) ──

function CardListItem({
  card, isActive, onSelect,
}: {
  card:     CharacterCard;
  isActive: boolean;
  onSelect: () => void;
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
