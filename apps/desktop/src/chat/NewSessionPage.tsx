import { useEffect, useState, type JSX } from 'react';
import { charactersApi } from '../api/characters.js';
import { fetchServerObjectUrl } from '../lib/serverFileUrl.js';
import { useCharacterStore } from '../stores/character.js';
import { useSessionStore } from '../stores/session.js';
import { ChatInput } from './input/ChatInput.js';
import { emptyChatDraft, replaceDraftText } from './input/InputReferences.js';
import { useChatWorkspace } from './state/chatWorkspace.js';

/* 快捷动作:点选把 prompt 填入新会话草稿,用户再编辑/发送。 */
const QUICK_PROMPTS = [
  { icon: 'i-lucide:code', label: '梳理项目结构', prompt: '梳理一下当前项目的结构' },
  { icon: 'i-lucide:palette', label: '设计一段交互', prompt: '帮我设计一段界面交互' },
  { icon: 'i-lucide:list-todo', label: '整理工作计划', prompt: '帮我整理一份今天的工作计划' },
  { icon: 'i-lucide:sparkles', label: '先聊一会儿', prompt: '先陪我聊一会儿' },
] as const;

function fillQuickPrompt(prompt: string): void {
  const workspace = useChatWorkspace.getState();
  const draft = workspace.newSessionDraft ?? emptyChatDraft();
  workspace.setDraft({ ...draft, parts: replaceDraftText(draft.parts, prompt) });
}

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
      {/* TODO: 新对话侧栏待接入；有项目时提供浏览器和文件，无项目时仅提供浏览器。 */}
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
        <span className="ema-empty-state-eyebrow" aria-hidden>a little company, a lot of possibilities</span>
        <div className="ema-empty-state-prompts">
          {QUICK_PROMPTS.map((item) => (
            <button
              key={item.label}
              type="button"
              className="ema-empty-state-prompt"
              onClick={() => fillQuickPrompt(item.prompt)}
            >
              <span className={`${item.icon} text-sm`} aria-hidden />
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <ChatInput />
    </main>
  );
}
