import type { SessionListItem } from '../../api/sessions.js';
import { emptyChatDraft, useChatDraftStore, type ChatDraft } from '../../stores/chatDraft.js';
import { useSessionStore } from '../../stores/session.js';

export function draftFromSession(session: SessionListItem | undefined): ChatDraft {
  return {
    ...emptyChatDraft(),
    permissionMode: session?.permissionMode ?? 'default',
    ttsEnabled: session?.ttsEnabled ?? false,
    reasoningEffort: session?.reasoningEffort ?? 'off',
  };
}

export function editChatDraft(
  sessionId: string | null,
  edit: (current: ChatDraft) => ChatDraft,
): void {
  const drafts = useChatDraftStore.getState();
  // 文件选择和拖放会异步返回. 更新原会话的最新草稿, 不覆盖后来输入的内容.
  if (sessionId) {
    const session = useSessionStore.getState().sessions.byId.get(sessionId);
    if (!session) return;
    const current = drafts.bySession.get(sessionId) ?? draftFromSession(session);
    drafts.setForSession(sessionId, edit(current));
  } else {
    drafts.setForNewSession(edit(drafts.newSessionDraft));
  }
}
