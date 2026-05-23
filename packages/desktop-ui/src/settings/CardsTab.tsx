/**
 * CardsTab — list character cards + select to edit.
 */
import { useState } from 'react';
import { useCardStore } from '../stores/card-store.js';
import { cardsApi } from '../api/cards.js';
import type { CharacterCardWire } from '../api/cards.js';
import { CharacterCardEditor } from './CharacterCardEditor.js';
import { showToast } from '../lib/toast.js';
import type { CharacterCardId } from '@ema-agent/contracts';

export function CardsTab(): JSX.Element {
  const cards = useCardStore((s) => s.cards);
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
    <div className="flex gap-6 h-full">
      {/* Left: card list */}
      <div className="w-72 flex-shrink-0 flex flex-col gap-2 overflow-y-auto">
        <button
          className="px-4 py-2 rounded-xl bg-pink-400/20 text-pink-300 text-sm hover:bg-pink-400/30 transition-colors"
          onClick={handleCreate}
        >新建角色卡</button>

        {cards.map((card) => (
          <button
            key={card.id}
            className={`text-left px-4 py-3 rounded-xl border transition-colors ${
              selectedId === card.id
                ? 'border-pink-400/40 bg-pink-400/10'
                : 'border-gray-700 bg-gray-800 hover:bg-gray-750'
            }`}
            onClick={() => setSelectedId(card.id as CharacterCardId)}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-sm">{card.name}</span>
              <div className="flex items-center gap-1">
                {card.id === activeCardId && (
                  <span className="text-xs text-green-400">● 当前</span>
                )}
                {card.isBuiltin && (
                  <span className="text-xs text-gray-500">内置</span>
                )}
              </div>
            </div>
            {card.description && (
              <div className="text-xs text-gray-500 mt-1 line-clamp-2">{card.description}</div>
            )}
          </button>
        ))}
      </div>

      {/* Right: card editor */}
      <div className="flex-1">
        {selected ? (
          <CharacterCardEditor
            card={selected}
            onActivate={() => handleActivate(selected.id as CharacterCardId)}
          />
        ) : (
          <div className="text-gray-500 text-center mt-20">选择一张角色卡编辑</div>
        )}
      </div>
    </div>
  );
}
