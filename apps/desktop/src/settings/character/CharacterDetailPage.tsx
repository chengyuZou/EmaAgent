// L2 角色详情壳:顶部 58px 只有返回 + Tab 条,无 Hero 区;Tab 内容各自成文件。
import { useEffect, useState, type JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { useCharacterStore } from '../../stores/character.js';
import { CharacterInfoTab } from './CharacterInfoTab.js';
import { Live2dTab } from './Live2dTab.js';
import { IllustrationTab } from './IllustrationTab.js';
import { VoiceTab } from './VoiceTab.js';

type DetailTab = 'info' | 'live2d' | 'illustration' | 'voice';

export function CharacterDetailPage({
  name, onBack,
}: {
  name: string;
  onBack(): void;
}): JSX.Element {
  const [tab, setTab] = useState<DetailTab>('info');
  const character = useCharacterStore(s => s.characters.find(c => c.name === name));

  useEffect(() => {
    if (!useCharacterStore.getState().characters.length) {
      void useCharacterStore.getState().load();
    }
  }, []);

  if (!character) {
    return (
      <div className="flex h-48 items-center justify-center">
        {useCharacterStore(s => s.loading)
          ? <Spinner size="md" />
          : <Callout variant="danger">角色「{name}」不存在或已被删除</Callout>}
      </div>
    );
  }

  const tabs: Array<{ id: DetailTab; label: string }> = [
    { id: 'info', label: '角色信息' },
    { id: 'live2d', label: `Live2D · ${character.live2dModels.length}` },
    { id: 'illustration', label: `插图 · ${character.illustrations.length}` },
    { id: 'voice', label: `参考音频 · ${character.voiceSamples.length}` },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[58px] shrink-0 items-center gap-4 border-b border-[var(--ema-border)] px-4">
        <button
          type="button"
          className="flex items-center gap-1 text-sm text-[var(--ema-text-secondary)]
            transition-colors hover:text-[var(--ema-text-primary)]"
          onClick={onBack}
        >
          <span className="i-mdi:arrow-left" aria-hidden />角色卡
        </button>
        <div className="flex gap-1">
          {tabs.map(item => (
            <button
              key={item.id}
              type="button"
              className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
                tab === item.id
                  ? 'bg-[var(--ema-primary-muted)] text-[var(--ema-primary)]'
                  : 'text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-secondary)]'
              }`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'info' && <CharacterInfoTab character={character} />}
        {tab === 'live2d' && <Live2dTab character={character} />}
        {tab === 'illustration' && <IllustrationTab character={character} />}
        {tab === 'voice' && <VoiceTab character={character} />}
      </div>
    </div>
  );
}
