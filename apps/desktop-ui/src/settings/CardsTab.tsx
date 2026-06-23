import { useState, type JSX } from 'react';
import { Badge, Button, Card, ScrollArea } from '@ema-agent/ui';
import { useCardStore } from '../stores/card-store.js';
import type { CharacterCard } from '../api/cards.js';
import { CharacterCardEditor } from './CharacterCardEditor.js';
import { showToast } from '../lib/toast.js';
import type { CharacterCardId } from '@ema-agent/contracts';

export function CardsTab(): JSX.Element {
  const cards       = useCardStore((s) => s.cards);
  const activeCardId = useCardStore((s) => s.activeCardId);
  const [selectedId, setSelectedId] = useState<CharacterCardId | null>(null);

  const selected = cards.find((c) => c.id === selectedId);

  async function handleCreate(): Promise<void> {
    try {
      const card = await useCardStore.getState().create({
        name:         '新角色',
        systemPrompt: '你是一个AI助手。',
        version:      '1.0',
      });
      setSelectedId(card.id);
      showToast('已创建', { variant: 'success' });
    } catch (err: unknown) {
      showToast(`创建失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    }
  }

  async function handleActivate(id: CharacterCardId): Promise<void> {
    try {
      await useCardStore.getState().activate(id);
      showToast('已切换角色', { variant: 'success' });
    } catch (err: unknown) {
      showToast(`切换失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    }
  }

  return (
    <div className="flex gap-6">
      {/* Left: card list */}
      <div className="w-72 shrink-0 flex flex-col gap-2">
        {/* TODO: V1 单角色，暂不开放新建入口，待多角色支持后恢复。
        <Button variant="primary" size="sm" block onClick={handleCreate} className="active:scale-[0.98] transition-all duration-250">
          <span className="i-mdi:plus text-base" aria-hidden />
          新建角色卡
        </Button>
        */}

        <ScrollArea className="flex-1" viewportClassName="pb-2">
          <div className="flex flex-col gap-1.5 pr-1">
            {cards.map((card) => (
              <CardListItem
                key={card.id}
                card={card}
                isActive={card.id === activeCardId}
                isSelected={selectedId === card.id}
                onSelect={() => setSelectedId(card.id as CharacterCardId)}
              />
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Right: card editor */}
      <div className="flex-1 min-w-0">
        {selected ? (
          <CharacterCardEditor
            card={selected}
            onActivate={() => handleActivate(selected.id as CharacterCardId)}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-neutral-500 text-sm">
            选择一张角色卡编辑
          </div>
        )}
      </div>
    </div>
  );
}

// ── Card list item ────────────────────────────────────────────────────────────

function CardListItem({
  card, isActive, isSelected, onSelect,
}: {
  card:       CharacterCard;
  isActive:   boolean;
  isSelected: boolean;
  onSelect:   () => void;
}): JSX.Element {
  return (
    <Card
      variant={isSelected ? 'glass' : 'elevated'}
      padding="sm"
      className={`cursor-pointer transition-all duration-250 active:scale-[0.98] ${
        isSelected
          ? 'border border-primary-400/30 bg-primary-500/10'
          : 'hover:bg-neutral-800/80'
      }`}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-neutral-100 leading-snug">{card.name}</span>
        <div className="flex items-center gap-1 shrink-0 mt-0.5">
          {isActive && <Badge variant="success" dot>当前</Badge>}
          {card.isBuiltin && <Badge variant="neutral">内置</Badge>}
        </div>
      </div>
      {card.description && (
        <p className="text-xs text-neutral-500 mt-1 line-clamp-2">{card.description}</p>
      )}
    </Card>
  );
}
