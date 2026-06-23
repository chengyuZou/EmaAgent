/**
 * CharacterCardEditor — card editor with 3 tabs: Identity / Behavior / Voice.
 */
import { useState, type JSX } from 'react';
import { Button, Tabs } from '@ema-agent/ui';
import type { CharacterCard } from '../api/cards.js';
import { IdentityTab } from './IdentityTab.js';
import { BehaviorTab } from './BehaviorTab.js';
import { VoiceTab } from './VoiceTab.js';
import type { CharacterCardId } from '@ema-agent/contracts';

export interface CharacterCardEditorProps {
  card:        CharacterCard;
  onActivate(): void;
}

export function CharacterCardEditor({ card, onActivate }: CharacterCardEditorProps): JSX.Element {
  const [activeTab, setActiveTab] = useState('identity');

  const tabItems = [
    {
      value:   'identity',
      label:   '身份',
      content: <IdentityTab card={card} />,
    },
    {
      value:   'behavior',
      label:   '行为',
      content: <BehaviorTab card={card} />,
    },
    {
      value:   'voice',
      label:   '音色',
      content: <VoiceTab cardId={card.id as CharacterCardId} voiceProfile={card.voiceProfile} />,
    },
  ];

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">{card.name}</h2>
        <div className="flex items-center gap-2">
          {card.isActive ? (
            <span className="text-xs text-green-400 px-2 py-1 rounded-lg bg-green-400/10">当前使用</span>
          ) : (
            <Button variant="primary" size="sm" onClick={onActivate}>切换至此</Button>
          )}
          <span className="text-xs text-neutral-500">v{card.version}</span>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        orientation="horizontal"
        variant="underline"
      />
    </div>
  );
}
