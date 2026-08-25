/**
 * CharacterCardEditor — card editor with 5 tabs: Identity / Behavior / Live2D / Portraits / Voice.
 */
import { useState, type JSX } from 'react';
import { Button, Tabs } from '@ema-agent/ui';
import type { CharacterCard } from '../../api/cards.js';
import { IdentityTab } from './IdentityTab.js';
import { BehaviorTab } from './BehaviorTab.js';
import { VoiceTab } from './voice/VoiceTab.js';
import { Live2DTab } from './live2d/Live2DTab.js';
import { PortraitsTab } from './portraits/PortraitsTab.js';
import { HealthBadge } from './shared/HealthBadge.js';

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
      value:   'live2d',
      label:   'Live2D',
      content: <Live2DTab card={card} />,
    },
    {
      value:   'portraits',
      label:   '立绘',
      content: <PortraitsTab card={card} />,
    },
    {
      value:   'voice',
      label:   '音色',
      content: <VoiceTab cardId={card.id} voiceReferences={card.voiceReferences} isBuiltin={card.isBuiltin} />,
    },
  ];

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-lg font-semibold text-[var(--ema-text-primary)] truncate">{card.name}</h2>
          <HealthBadge cardId={card.id} />
        </div>
        <div className="flex items-center gap-2">
          {card.isActive ? (
            <span className="text-xs text-[var(--ema-success-text)] px-2 py-1 rounded-lg bg-[var(--ema-success-muted)]">
              当前使用
            </span>
          ) : (
            <Button variant="primary" size="sm" onClick={onActivate}>切换至此</Button>
          )}
          <span className="text-xs text-[var(--ema-text-tertiary)]">v{card.version}</span>
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
