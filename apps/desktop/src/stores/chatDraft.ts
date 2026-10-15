import { create } from 'zustand';
import type { AttachmentBlock, ReasoningEffort } from '@ema-agent/session';
import type { PermissionMode } from '@ema-agent/permission';
import type { QueuedSessionInput, TurnInputPart } from '@ema-agent/turn';

/**
 * 输入框上方的有序胶囊. 纯文本只存在 text 中, 不再靠隐藏 offset 与这些项交错.
 * draftId 在加入草稿时生成, 删除前面的胶囊也不会改变剩余胶囊的 React key.
 * 发送时只取后端认识的字段, 不能把这个界面 ID 写进 UserMessage.
 * 新附件保留本机路径或剪贴板 File; 队列退回的附件复用已上传的路径.
 */
export type ChatDraftReference = { readonly draftId: string } & (
  | Extract<TurnInputPart, { readonly type: 'skill_reference' }>
  | AttachmentBlock
  | { readonly type: 'image'; readonly sourcePath: string; readonly file?: never; readonly name?: string }
  | { readonly type: 'image'; readonly file: File; readonly sourcePath?: never; readonly name?: string }
  | { readonly type: 'pasted_text'; readonly content: string; readonly preview: string }
);

export interface ChatDraft {
  readonly text: string;
  readonly references: readonly ChatDraftReference[];
  readonly permissionMode: PermissionMode;
  /** 新对话创建前暂存 TTS 选择; 已有对话以 Session 保存的值为准. */
  readonly ttsEnabled: boolean;
  /** 新对话首发前暂存模型; 已有 Session 以 Server 保存的 providerId/modelId 为准. */
  readonly providerId?: string;
  readonly modelId?: string;
  readonly reasoningEffort: ReasoningEffort;
}

export function emptyChatDraft(): ChatDraft {
  return {
    text: '',
    references: [],
    permissionMode: 'default',
    ttsEnabled: false,
    reasoningEffort: 'off',
  };
}

export function hasDraftContent(draft: ChatDraft): boolean {
  return draft.text.trim().length > 0 || draft.references.length > 0;
}

/** 请求失败时先还回被清掉的输入, 再接上等待期间新写的内容, 不能丢任一份. */
export function restoreFailedDraft(submitted: ChatDraft, current: ChatDraft | undefined): ChatDraft {
  if (!current) return submitted;
  return {
    ...current,
    text: submitted.text + current.text,
    references: [...submitted.references, ...current.references],
  };
}

/** 队列尚未保存的输入放在现有草稿之前, 已上传的附件不重复创建文件. */
export function restoreQueuedDraft(items: readonly QueuedSessionInput[], current: ChatDraft): ChatDraft {
  const texts: string[] = [];
  const references: ChatDraftReference[] = [];
  for (const item of items) {
    let text = '';
    for (const part of item.input) {
      if (part.type === 'text') {
        text += part.text;
      } else if (part.type === 'attachment') {
        references.push({ ...part.block, draftId: crypto.randomUUID() });
      } else {
        references.push({ ...part, draftId: crypto.randomUUID() });
      }
    }
    if (text) {
      texts.push(text);
    }
  }
  if (current.text) {
    texts.push(current.text);
  }
  return {
    ...current,
    text: texts.join('\n\n'),
    references: [...references, ...current.references],
  };
}

interface ChatDraftStore {
  readonly bySession: ReadonlyMap<string, ChatDraft>;
  readonly newSessionDraft: ChatDraft;
  setForSession(sessionId: string, draft: ChatDraft): void;
  setForNewSession(draft: ChatDraft): void;
  promoteNewSession(sessionId: string): void;
  evictSession(sessionId: string): void;
}

export const useChatDraftStore = create<ChatDraftStore>((set, get) => ({
  bySession: new Map(),
  newSessionDraft: emptyChatDraft(),

  setForSession(sessionId, draft) {
    set(state => ({ bySession: new Map(state.bySession).set(sessionId, draft) }));
  },

  setForNewSession(draft) {
    set({ newSessionDraft: draft });
  },

  promoteNewSession(sessionId) {
    const bySession = new Map(get().bySession);
    bySession.set(sessionId, get().newSessionDraft);
    set({ bySession, newSessionDraft: emptyChatDraft() });
  },

  evictSession(sessionId) {
    set(state => {
      const bySession = new Map(state.bySession);
      bySession.delete(sessionId);
      return { bySession };
    });
  },
}));
