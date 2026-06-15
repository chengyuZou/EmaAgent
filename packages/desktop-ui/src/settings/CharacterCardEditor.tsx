/**
 * CharacterCardEditor — card editor with 3 tabs: Identity / Behavior / Voice.
 */
import { useState, type JSX } from 'react';
import type { CharacterCard } from '../api/cards.js';
import { IdentityTab } from './IdentityTab.js';
import { BehaviorTab } from './BehaviorTab.js';
import { VoiceTab } from './VoiceTab.js';
import type { CharacterCardId } from '@ema-agent/contracts';

type EditorTab = 'identity' | 'behavior' | 'voice';

const TABS: Array<{ id: EditorTab; label: string }> = [
  { id: 'identity', label: '身份' },
  { id: 'behavior', label: '行为' },
  { id: 'voice',    label: '音色' },
];

export interface CharacterCardEditorProps {
  card:        CharacterCard;
  onActivate(): void;
}

export function CharacterCardEditor({ card, onActivate }: CharacterCardEditorProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<EditorTab>('identity');

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">{card.name}</h2>
        <div className="flex items-center gap-2">
          {card.isActive ? (
            <span className="text-xs text-green-400 px-2 py-1 rounded-lg bg-green-400/10">当前使用</span>
          ) : (
            <button
              className="text-xs px-2 py-1 rounded-lg bg-pink-400/20 text-pink-300 hover:bg-pink-400/30"
              onClick={onActivate}
            >切换至此</button>
          )}
          <span className="text-xs text-neutral-500">v{card.version}</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-neutral-800 pb-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`px-4 py-2 rounded-t-lg text-sm transition-colors ${
              activeTab === tab.id
                ? 'text-pink-300 border-b-2 border-pink-400'
                : 'text-neutral-400 hover:text-neutral-200'
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <TabContent tab={activeTab} card={card} />
    </div>
  );
}

function TabContent({ tab, card }: { tab: EditorTab; card: CharacterCard }): JSX.Element {
  switch (tab) {
    case 'identity': return <IdentityTab card={card} />;
    case 'behavior': return <BehaviorTab card={card} />;
    case 'voice':    return <VoiceTab cardId={card.id as CharacterCardId} voiceProfile={card.voiceProfile} />;
    default:         return <div>未知标签</div>;
  }
}
