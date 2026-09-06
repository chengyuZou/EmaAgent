/**
 * CharacterEditor — character editor with 4 tabs: Identity / Live2D / Illustrations / Voice.
 */
import { useState, type JSX } from 'react';
import { Button, Tabs } from '@ema-agent/ui';
import type { Character } from '../../api/characters.js';
import { IdentityTab } from './IdentityTab.js';
import { VoiceTab } from './voice/VoiceTab.js';
import { Live2DTab } from './live2d/Live2DTab.js';
import { IllustrationTab } from './illustration/IllustrationTab.js';

export interface CharacterEditorProps {
  character:   Character;
  onActivate(): void;
}

export function CharacterEditor({ character, onActivate }: CharacterEditorProps): JSX.Element {
  const [activeTab, setActiveTab] = useState('identity');

  const tabItems = [
    {
      value:   'identity',
      label:   '身份',
      content: <IdentityTab character={character} />,
    },
    {
      value:   'live2d',
      label:   'Live2D',
      content: <Live2DTab character={character} />,
    },
    {
      value:   'illustrations',
      label:   '立绘',
      content: <IllustrationTab character={character} />,
    },
    {
      value:   'voice',
      label:   '音色',
      content: <VoiceTab characterId={character.id} voiceSamples={character.voiceSamples} isBuiltin={character.isBuiltin} />,
    },
  ];

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-lg font-semibold text-[var(--ema-text-primary)] truncate">{character.name}</h2>
        </div>
        <div className="flex items-center gap-2">
          {character.isActive ? (
            <span className="text-xs text-[var(--ema-success-text)] px-2 py-1 rounded-lg bg-[var(--ema-success-muted)]">
              当前使用
            </span>
          ) : (
            <Button variant="primary" size="sm" onClick={onActivate}>切换至此</Button>
          )}
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
