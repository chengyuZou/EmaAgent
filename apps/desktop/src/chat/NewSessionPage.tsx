import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import { charactersApi } from '../api/characters.js';
import { fetchServerObjectUrl } from '../lib/serverFileUrl.js';
import { useCharacterStore } from '../stores/character.js';
import { useSessionStore } from '../stores/session.js';
import { ChatInput } from './input/ChatInput.js';
import { restoreFailedDraft, useChatDraftStore, type ChatDraft } from '../stores/chatDraft.js';
import { useChatNavigationStore } from '../stores/chatNavigation.js';
import { submitChatDraft } from './input/submitChatDraft.js';

/* 快捷动作:点选把 prompt 填入新会话草稿,用户再编辑/发送。 */
const QUICK_PROMPTS = [
  { icon: 'i-lucide:code', label: '梳理项目结构', prompt: '梳理一下当前项目的结构' },
  { icon: 'i-lucide:palette', label: '设计一段交互', prompt: '帮我设计一段界面交互' },
  { icon: 'i-lucide:list-todo', label: '整理工作计划', prompt: '帮我整理一份今天的工作计划' },
  { icon: 'i-lucide:sparkles', label: '先聊一会儿', prompt: '先陪我聊一会儿' },
] as const;

function fillQuickPrompt(prompt: string): void {
  const drafts = useChatDraftStore.getState();
  const draft = drafts.newSessionDraft;
  drafts.setForNewSession({ ...draft, text: prompt });
}

export function NewSessionPage(): JSX.Element {
  const characterName = useCharacterStore(state => state.activeName);
  const character = useCharacterStore((state) => (
    state.characters.find((item) => item.name === state.activeName)
  ));
  const projectId = useChatNavigationStore(state => state.newSessionProjectId);
  const pinnedProjects = useSessionStore(state => state.sessions.pinnedProjects);
  const projects = useSessionStore(state => state.sessions.projects);
  const [illustrationUrl, setIllustrationUrl] = useState<string | null>(null);
  const project = pinnedProjects.find(item => item.id === projectId)
    ?? projects.find(item => item.id === projectId);

  async function submitNewSession(submitted: ChatDraft): Promise<void> {
    const navigation = useChatNavigationStore.getState();
    const selectedProjectId = navigation.newSessionProjectId;
    const explicitCwd = navigation.newSessionCwd?.trim();
    let sessionId: string;
    try {
      if (navigation.newSessionCwd !== null && !explicitCwd) {
        throw new Error('请输入执行目录');
      }
      sessionId = await useSessionStore.getState().createSession({
        ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
        ...(explicitCwd ? { cwd: explicitCwd } : {}),
        sessionMode: submitted.sessionMode,
        narrativePolicy: submitted.narrativePolicy,
        permissionMode: submitted.permissionMode,
        ttsEnabled: submitted.ttsEnabled,
        providerId: submitted.providerId!,
        modelId: submitted.modelId!,
        reasoningEffort: submitted.reasoningEffort,
      });
    } catch (error) {
      const drafts = useChatDraftStore.getState();
      drafts.setForNewSession(restoreFailedDraft(submitted, drafts.newSessionDraft));
      throw error;
    }

    // 新 Session 已存在, 才能把后来输入的草稿迁过去并上传属于该 Session 的附件.
    useChatDraftStore.getState().promoteNewSession(sessionId);
    navigation.promoteNewSession(sessionId);
    await submitChatDraft(sessionId, submitted);
  }

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
        <div className="ema-empty-state-glow ema-fade-in" aria-hidden />
        {illustrationUrl ? (
          <img
            className="ema-empty-state-avatar ema-stagger-in"
            style={{ '--stagger-i': 0 } as CSSProperties}
            src={illustrationUrl}
            alt={character?.name ?? '角色'}
            draggable={false}
          />
        ) : (
          <div
            className="ema-empty-state-avatar ema-empty-state-avatar-fallback ema-stagger-in"
            style={{ '--stagger-i': 0 } as CSSProperties}
            aria-hidden
          >
            <span className="i-lucide:paw-print" />
          </div>
        )}
        <h2
          className="ema-empty-state-title ema-stagger-in"
          style={{ '--stagger-i': 1 } as CSSProperties}
        >
          {project
            ? `你想在 ${project.name} 中构建什么?`
            : character
              ? `和 ${character.name} 开始聊天`
              : '开始聊天吧'}
        </h2>
        <span
          className="ema-empty-state-eyebrow ema-stagger-in"
          style={{ '--stagger-i': 2 } as CSSProperties}
          aria-hidden
        >
          a little company, a lot of possibilities
        </span>
        <div className="ema-empty-state-prompts">
          {QUICK_PROMPTS.map((item, index) => (
            <button
              key={item.label}
              type="button"
              className="ema-empty-state-prompt ema-stagger-in"
              style={{ '--stagger-i': 3 + index } as CSSProperties}
              onClick={() => fillQuickPrompt(item.prompt)}
            >
              <span className={`${item.icon} text-sm`} aria-hidden />
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <ChatInput onSubmit={submitNewSession} />
    </main>
  );
}
