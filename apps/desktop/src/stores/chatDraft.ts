import { create } from 'zustand';
import type { AttachmentBlock, SessionMode, NarrativePolicy, ReasoningEffort } from '@ema-agent/session';
import type { PermissionMode } from '@ema-agent/permission';
import type { TurnInputPart } from '@ema-agent/turn';

/**
 * 输入框上方的有序胶囊. 纯文本只存在 text 中, 不再靠隐藏 offset 与这些项交错.
 * draftId 在加入草稿时生成, 删除前面的胶囊也不会改变剩余胶囊的 React key.
 * 发送时只取后端认识的字段, 不能把这个界面 ID 写进 UserMessage.
 * 图片此时只有本机路径或剪贴板 File; 上传成功后才会有后端保存的图片路径.
 */
export type ChatDraftReference = { readonly draftId: string } & (
  | Extract<TurnInputPart, { readonly type: 'skill_reference' }>
  | Extract<AttachmentBlock, { readonly type: 'file_reference' }>
  | { readonly type: 'image'; readonly sourcePath: string; readonly file?: never; readonly name?: string }
  | { readonly type: 'image'; readonly file: File; readonly sourcePath?: never; readonly name?: string }
  | { readonly type: 'pasted_text'; readonly content: string; readonly preview: string }
);

export interface ChatDraft {
  readonly text: string;
  readonly references: readonly ChatDraftReference[];
  /** KB 只限制本轮检索范围, 不占输入项顺序, 也不显示为胶囊. */
  readonly selectedAssetIds: readonly string[];
  readonly sessionMode: SessionMode;
  readonly narrativePolicy: NarrativePolicy;
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
    selectedAssetIds: [],
    sessionMode: 'chat',
    narrativePolicy: 'auto',
    permissionMode: 'default',
    ttsEnabled: false,
    reasoningEffort: 'off',
  };
}

/** 单独选中 KB 文档不能发送; 有文字或任意胶囊才形成 UserMessage. */
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

interface ChatDraftStore {
  readonly bySession: ReadonlyMap<string, ChatDraft>;
  readonly newSessionDraft: ChatDraft;
  setForSession(sessionId: string, draft: ChatDraft): void;
  setForNewSession(draft: ChatDraft): void;
  promoteNewSession(sessionId: string): void;
  evictSession(sessionId: string): void;
  /** 激活库切换后, 所有未发送草稿都不能继续携带旧库的文档 ID. */
  clearSelectedAssetIds(): void;
  removeSelectedAssetId(assetId: string): void;
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

  clearSelectedAssetIds() {
    set(state => ({
      newSessionDraft: { ...state.newSessionDraft, selectedAssetIds: [] },
      bySession: new Map([...state.bySession].map(([id, draft]) => [
        id, { ...draft, selectedAssetIds: [] },
      ])),
    }));
  },

  removeSelectedAssetId(assetId) {
    set(state => ({
      newSessionDraft: {
        ...state.newSessionDraft,
        selectedAssetIds: state.newSessionDraft.selectedAssetIds.filter(id => id !== assetId),
      },
      bySession: new Map([...state.bySession].map(([id, draft]) => [
        id, { ...draft, selectedAssetIds: draft.selectedAssetIds.filter(selected => selected !== assetId) },
      ])),
    }));
  },
}));
