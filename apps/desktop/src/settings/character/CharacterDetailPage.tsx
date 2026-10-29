import { useEffect, useState, type JSX } from 'react';
import { Button, Callout, ScrollArea, Spinner, Tabs } from '@ema-agent/ui';
import { charactersApi, type Character } from '../../api/characters.js';
import { ServerApiError } from '../../api/client.js';
import { useCharacterStore } from '../../stores/character.js';
import { CharacterInfoTab } from './CharacterInfoTab.js';
import { Live2dTab } from './Live2dTab.js';
import { IllustrationTab } from './IllustrationTab.js';
import { VoiceTab } from './VoiceTab.js';

import { StickersTab } from './StickersTab.js';

type DetailTab = 'info' | 'live2d' | 'illustration' | 'voice' | 'stickers';

export function CharacterDetailPage({
  name, onBack,
}: {
  name: string;
  onBack(): void;
}): JSX.Element {
  const [tab, setTab] = useState<DetailTab>('info');
  const [character, setCharacter] = useState<Character | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const summaries = useCharacterStore(s => s.characters);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void charactersApi.get(name)
      .then(value => {
        if (!cancelled) {
          setCharacter(value);
          setLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCharacter(null);
          if (error instanceof ServerApiError && error.status === 404) {
            setLoadError(`角色「${name}」不存在或已被删除`);
          } else if (error instanceof Error) {
            setLoadError(error.message);
          } else {
            setLoadError('角色详情读取失败');
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [name, summaries]);

  if (!character || character.name !== name) {
    return (
      <div className="flex h-48 items-center justify-center">
        {loading
          ? <Spinner size="md" />
          : <Callout variant="danger">{loadError}</Callout>}
      </div>
    );
  }

  const tabs: Array<{ id: DetailTab; label: string }> = [
    { id: 'info', label: '角色信息' },
    { id: 'live2d', label: 'Live2D' },
    { id: 'illustration', label: '插图' },
    { id: 'voice', label: '参考音频' },
    { id: 'stickers', label: '表情包' },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[58px] shrink-0 items-center gap-4 border-b border-[var(--ema-border)] px-4">
        <Button variant="ghost" className="shrink-0" icon="i-mdi:arrow-left" onClick={onBack}>
          角色卡
        </Button>
        <ScrollArea orientation="horizontal" scrollbar="always" className="min-w-0 flex-1">
          <Tabs
            className="ema-character-tabs py-2"
            value={tab}
            onChange={value => setTab(value as DetailTab)}
            variant="pill"
            triggersOnly
            items={tabs.map(item => ({ value: item.id, label: item.label, content: null }))}
          />
        </ScrollArea>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'info' && <CharacterInfoTab character={character} />}
        {tab === 'live2d' && <Live2dTab character={character} />}
        {tab === 'illustration' && <IllustrationTab character={character} />}
        {tab === 'voice' && <VoiceTab character={character} />}
        {tab === 'stickers' && <StickersTab character={character} />}
      </div>
    </div>
  );
}
