import { useEffect, useState, type JSX } from 'react';
import { charactersApi } from '../api/characters.js';
import { fetchServerObjectUrl } from '../lib/serverFileUrl.js';
import { useCharacterStore } from '../stores/character.js';
import { useSessionStore } from '../stores/session.js';
import { ChatInput } from './input/ChatInput.js';
import { useChatWorkspace } from './state/chatWorkspace.js';

export function NewSessionPage(): JSX.Element {
  const characterName = useCharacterStore(state => state.activeName);
  const character = useCharacterStore((state) => (
    state.characters.find((item) => item.name === state.activeName)
  ));
  const projectId = useChatWorkspace(state => state.newSessionProjectId);
  const sessions = useSessionStore(state => state.sessions);
  const [illustrationUrl, setIllustrationUrl] = useState<string | null>(null);
  const project = [...sessions.pinnedProjects, ...sessions.projects]
    .find((item) => item.id === projectId);

  useEffect(() => {
    if (!characterName) {
      setIllustrationUrl(null);
      return;
    }
    let mounted = true;
    let objectUrl: string | null = null;
    void charactersApi.presentation(characterName).then(async presentation => {
      if (presentation.status !== 'illustration') return null;
      return fetchServerObjectUrl(charactersApi.illustrationFileUrl(
        characterName,
        presentation.resource.name,
      ));
    }).then((url) => {
      if (!mounted) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      objectUrl = url;
      setIllustrationUrl(url);
    }).catch(() => {
      if (mounted) setIllustrationUrl(null);
    });
    return () => {
      mounted = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [characterName]);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center border-b border-[var(--ema-border)] px-4 py-2">
        <span className="text-sm font-medium text-[var(--ema-text-secondary)]">
          新对话{project ? ` · ${project.name}` : ''}
        </span>
      </header>
      <div className="ema-empty-state flex-1">
        <div className="ema-empty-state-glow" aria-hidden />
        {illustrationUrl ? (
          <img
            className="ema-empty-state-avatar"
            src={illustrationUrl}
            alt={character?.name ?? '角色'}
            draggable={false}
          />
        ) : (
          <div className="ema-empty-state-avatar ema-empty-state-avatar-fallback" aria-hidden>
            <span className="i-lucide:paw-print" />
          </div>
        )}
        <h2 className="ema-empty-state-title">
          {project
            ? `你想在 ${project.name} 中构建什么?`
            : character
              ? `和 ${character.name} 开始聊天`
              : '开始聊天吧'}
        </h2>
      </div>
      <ChatInput />
    </main>
  );
}
