import type { JSX } from 'react';
import { useSessionStore } from '../stores/session.js';
import { ChatInput } from './input/ChatInput.js';
import { restoreFailedDraft, useChatDraftStore, type ChatDraft } from '../stores/chatDraft.js';
import { useChatNavigationStore } from '../stores/chatNavigation.js';
import { submitChatDraft } from './input/submitChatDraft.js';
import { ConversationStarters } from './conversationStarters.js';

function fillQuickPrompt(prompt: string): void {
  const drafts = useChatDraftStore.getState();
  const draft = drafts.newSessionDraft;
  drafts.setForNewSession({ ...draft, text: prompt });
}

export function NewSessionPage(): JSX.Element {
  const projectId = useChatNavigationStore(state => state.newSessionProjectId);
  const pinnedProjects = useSessionStore(state => state.sessions.pinnedProjects);
  const projects = useSessionStore(state => state.sessions.projects);
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

  return (
    <main className="ema-chat-main ema-chat-content-surface relative z-10 flex min-h-0 min-w-0 flex-1 flex-col">
      {/* TODO: 新对话侧栏待接入；有项目时提供浏览器和文件，无项目时仅提供浏览器。 */}
      <header className="ema-chat-header flex shrink-0 items-center border-b border-[var(--ema-border)] px-4 py-2">
        <span className="text-sm font-medium text-[var(--ema-text-secondary)]">
          新对话{project ? ` · ${project.name}` : ''}
        </span>
      </header>
      <ConversationStarters onChoose={fillQuickPrompt} />
      <ChatInput onSubmit={submitNewSession} />
    </main>
  );
}
