// 将一份草稿提交到已经存在的 Session; 新对话必须先取得真实 Session ID.
import { knowledgeApi } from '../../api/knowledge.js';
import { ServerApiError } from '../../api/client.js';
import { SessionRequestError, sessionWebSocket } from '../../api/sessionWebSocket.js';
import { restoreFailedDraft, useChatDraftStore, type ChatDraft } from '../../stores/chatDraft.js';
import { useKnowledgeStore } from '../../stores/knowledge.js';
import { useSessionActivityStore } from '../../stores/sessionActivity.js';
import { useSessionStore } from '../../stores/session.js';
import { ensureSessionSubscription } from '../session/sessionSubscriptions.js';
import { finalizeDraft } from './finalizeDraft.js';

export async function submitChatDraft(
  sessionId: string,
  submitted: ChatDraft,
): Promise<void> {
  let requestStarted = false;
  try {
    // 模型切换写入 Session 后, Turn 才能从同一份已保存设置读取模型.
    await useSessionStore.getState().waitForModelSettings(sessionId);
    const session = useSessionStore.getState().sessions.byId.get(sessionId);
    if (!session?.providerId || !session.modelId) {
      throw new Error('模型设置尚未保存, 请重新选择后发送');
    }

    if (submitted.sessionMode === 'work' && submitted.selectedAssetIds.length > 0) {
      const activeKbId = useKnowledgeStore.getState().libs.find(lib => lib.isActive)?.id;
      if (!activeKbId) throw new Error('没有激活知识库, 请重新选择文档');
      for (const assetId of submitted.selectedAssetIds) {
        let status: string;
        try {
          status = (await knowledgeApi.getDocument(activeKbId, assetId)).status;
        } catch (error) {
          if (!(error instanceof ServerApiError) || error.status !== 404) throw error;
          useChatDraftStore.getState().removeSelectedAssetId(assetId);
          throw new Error('所选知识库文档已删除, 请检查草稿后重发');
        }
        if (status !== 'ready') {
          useChatDraftStore.getState().removeSelectedAssetId(assetId);
          throw new Error('所选知识库文档尚未就绪, 请检查草稿后重发');
        }
      }
      if (useKnowledgeStore.getState().libs.find(lib => lib.isActive)?.id !== activeKbId) {
        throw new Error('激活知识库已变化, 请检查草稿后重发');
      }
    }

    // 权限选择必须排在先前的 Session 设置之后保存, Turn 才读取到本次提交的权限.
    await useSessionStore.getState().setPermissionMode(sessionId, submitted.permissionMode);
    ensureSessionSubscription(sessionId);
    const input = await finalizeDraft(sessionId, submitted);
    const payload = {
      input,
      sessionMode: submitted.sessionMode,
      narrativePolicy: submitted.narrativePolicy,
      ...(submitted.sessionMode === 'work' && submitted.selectedAssetIds.length > 0
        ? { knowledge: { assetIds: [...submitted.selectedAssetIds] } }
        : {}),
    };

    // 附件上传期间活动状态可能改变, 所以发送前才决定直接提交还是排队.
    const running = useSessionActivityStore.getState().bySession.get(sessionId)?.running;
    if (running?.kind === 'compact') {
      throw new Error('当前会话正在压缩, 请稍后发送');
    }
    requestStarted = true;
    if (running?.kind === 'turn') {
      await sessionWebSocket.queueUserMessage(sessionId, payload);
    } else {
      await sessionWebSocket.sendUserMessage(sessionId, payload);
    }
  } catch (error) {
    // 断线时 Server 可能已保存 UserMessage 或排队项, 不能把旧输入放回草稿诱导重复发送.
    const definitelyNotStored = !requestStarted
      || (error instanceof SessionRequestError
        && (
          error.code === 'empty_input'
          || error.code === 'session_idle'
          || error.code === 'session_busy'
          || error.code === 'session_not_found'
        ));
    if (definitelyNotStored) {
      const drafts = useChatDraftStore.getState();
      drafts.setForSession(sessionId, restoreFailedDraft(submitted, drafts.bySession.get(sessionId)));
    }
    throw error;
  }
}
